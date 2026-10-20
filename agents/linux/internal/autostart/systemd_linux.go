//go:build linux

package autostart

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strings"
	"time"

	"web2term/agent/internal/config"
	"web2term/agent/internal/daemon"
)

func systemctl(args ...string) (string, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	command := exec.CommandContext(ctx, "systemctl", args...)
	command.Env = append(os.Environ(), "SYSTEMD_PAGER=", "SYSTEMD_COLORS=0")
	data, err := command.CombinedOutput()
	if err != nil {
		return string(data), fmt.Errorf("systemctl %s 失败：%s（%w）", args[0], strings.TrimSpace(string(data)), err)
	}
	return string(data), nil
}

func checkSystemd() error {
	if _, err := os.Stat("/run/systemd/system"); err != nil {
		return errors.New("开机自启需要运行 systemd 的 Linux 主机；当前系统未检测到 systemd")
	}
	if _, err := exec.LookPath("systemctl"); err != nil {
		return errors.New("找不到 systemctl，无法管理开机自启")
	}
	return nil
}

func Run(action, path string, input io.Reader, output io.Writer) error {
	if action != "enable" && action != "disable" && action != "status" {
		return errors.New("用法：web2term autostart enable|disable|status")
	}
	if err := checkSystemd(); err != nil {
		return err
	}
	account, err := user.Current()
	if err != nil {
		return err
	}
	if os.Geteuid() == 0 && os.Getenv("SUDO_UID") != "" && os.Getenv("SUDO_UID") != "0" {
		return errors.New("请使用原登录用户直接执行 web2term autostart 命令，程序会按需请求 sudo，避免使用 root 的另一份配置")
	}
	if action == "status" {
		return printStatus(account.Uid, output)
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	if action == "enable" {
		hostname, _ := os.Hostname()
		if _, err := config.AgentConfig(absolute, time.Now(), hostname); err != nil {
			return err
		}
		fmt.Fprintln(output, "将启用开机自启并立即连接；如需接管手动启动的设备进程，该进程中的终端会话会关闭。")
	}
	if os.Geteuid() == 0 {
		return Privileged([]string{action, account.Uid, absolute}, output)
	}
	sudo, err := exec.LookPath("sudo")
	if err != nil {
		return errors.New("安装或停用系统服务需要 sudo 权限；当前用户找不到 sudo")
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	fmt.Fprintln(output, "正在请求 sudo 权限管理当前用户的自启服务，可能需要输入系统密码。")
	command := exec.Command(sudo, "--", executable, "__autostart", action, account.Uid, absolute)
	command.Stdin, command.Stdout, command.Stderr = input, output, output
	if err := command.Run(); err != nil {
		return fmt.Errorf("自启操作未完成，请检查上面的权限或服务错误：%w", err)
	}
	return nil
}

// Privileged is called only by the same executable through sudo, with the original UID.
// Credentials are never copied into the unit, process arguments or command output.
func Privileged(args []string, output io.Writer) error {
	if len(args) != 3 || (args[0] != "enable" && args[0] != "disable") || os.Geteuid() != 0 {
		return errors.New("请使用 web2term autostart enable 或 disable")
	}
	if err := checkSystemd(); err != nil {
		return err
	}
	action, uid, path := args[0], args[1], args[2]
	if original := os.Getenv("SUDO_UID"); original != "" && original != "0" && original != uid {
		return errors.New("服务用户与 sudo 发起用户不一致")
	}
	name, err := unitName(uid)
	if err != nil {
		return err
	}
	account, err := user.LookupId(uid)
	if err != nil {
		return err
	}
	m := manager{dir: "/etc/systemd/system", command: systemctl, stop: daemon.Stop}
	if action == "disable" {
		if err := m.disable(uid); err != nil {
			return err
		}
		_, err := fmt.Fprintln(output, "开机自启已关闭，系统服务已停止；登录配置和设备身份已保留。")
		return err
	}
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	executable, err = filepath.EvalSymlinks(executable)
	if err != nil {
		return err
	}
	if err := m.enable(serviceSpec{uid: uid, gid: account.Gid, home: account.HomeDir, executable: executable, config: path}); err != nil {
		return fmt.Errorf("启用自启未完成：%w", err)
	}
	fmt.Fprintf(output, "开机自启已启用：%s\n运行用户：%s（UID %s）\n机器重启后无需登录终端即可启动。\n", name, account.Username, uid)
	fmt.Fprintln(output, "查看设备连接：web2term status；查看自启：web2term autostart status。")
	fmt.Fprintln(output, "服务已启动不代表设备已在线，请用 web2term status 确认心跳。")
	return nil
}

func printStatus(uid string, output io.Writer) error {
	name, err := unitName(uid)
	if err != nil {
		return err
	}
	data, err := systemctl("show", "--no-pager", "--property=LoadState,UnitFileState,ActiveState,SubState", name)
	fields := make(map[string]string)
	for _, line := range strings.Split(data, "\n") {
		if key, value, ok := strings.Cut(line, "="); ok {
			fields[key] = value
		}
	}
	if fields["LoadState"] == "not-found" {
		_, err := fmt.Fprintln(output, "开机自启：未安装；执行 web2term autostart enable 启用。")
		return err
	}
	if err != nil {
		return err
	}
	enabled := "未开启"
	if fields["UnitFileState"] == "enabled" {
		enabled = "已开启"
	}
	_, err = fmt.Fprintf(output, "开机自启：%s\n系统服务：%s\n服务状态：%s / %s\n设备是否在线请运行 web2term status 查看。\n", enabled, name, fields["ActiveState"], fields["SubState"])
	return err
}
