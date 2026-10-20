package autostart

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"
)

const marker = "# Managed by web2term autostart; do not edit.\n"

type serviceSpec struct {
	uid, gid, home, executable, config string
}

func unitName(uid string) (string, error) {
	n, err := strconv.ParseUint(uid, 10, 32)
	if err != nil || strconv.FormatUint(n, 10) != uid {
		return "", errors.New("无效的 Linux 用户 ID")
	}
	return "web2term-" + uid + ".service", nil
}

// Escape systemd syntax, specifiers and ExecStart environment expansion; no shell is used.
func quote(value string, command bool) (string, error) {
	if strings.ContainsFunc(value, unicode.IsControl) {
		return "", errors.New("服务路径或用户信息不能含控制字符")
	}
	value = strings.NewReplacer("\\", "\\\\", "\"", "\\\"", "%", "%%").Replace(value)
	if command {
		value = strings.ReplaceAll(value, "$", "$$")
	}
	return "\"" + value + "\"", nil
}

func render(spec serviceSpec) (string, error) {
	if _, err := unitName(spec.uid); err != nil {
		return "", err
	}
	if _, err := unitName(spec.gid); err != nil {
		return "", errors.New("无效的 Linux 用户组 ID")
	}
	for _, path := range []string{spec.home, spec.executable, spec.config} {
		if !filepath.IsAbs(path) || strings.ContainsFunc(path, unicode.IsControl) {
			return "", errors.New("服务需要不含控制字符的绝对路径")
		}
	}
	executable, _ := quote(spec.executable, true)
	config, _ := quote(spec.config, true)
	home, _ := quote("HOME="+spec.home, false)
	return fmt.Sprintf(`%s[Unit]
Description=web2term device agent (UID %s)
Wants=network-online.target
After=network-online.target
RequiresMountsFor=%s
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=%s
Group=%s
Environment=%s
WorkingDirectory=~
ExecStart=%s __service %s
Restart=on-failure
RestartPreventExitStatus=78
RestartSec=10
TimeoutStopSec=30
KillMode=control-group
UMask=0077

[Install]
WantedBy=multi-user.target
`, marker, spec.uid, mustQuote(spec.config), spec.uid, spec.gid, home, executable, config), nil
}

func mustQuote(value string) string {
	quoted, _ := quote(value, false) // render validates paths before calling this
	return quoted
}

type manager struct {
	dir     string
	command func(...string) (string, error)
	stop    func(string) (bool, error)
}

func (m manager) managedFile(name string) (string, error) {
	path := filepath.Join(m.dir, name)
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	if !info.Mode().IsRegular() {
		return "", errors.New("已有服务文件不是普通文件，已保留，请手动检查")
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	if !strings.HasPrefix(string(data), marker) {
		return "", errors.New("已有同名服务不是本工具创建的，已保留，请手动检查")
	}
	return string(data), nil
}

func (m manager) enable(spec serviceSpec) error {
	content, err := render(spec)
	if err != nil {
		return err
	}
	name, _ := unitName(spec.uid)
	previous, err := m.managedFile(name)
	if err != nil {
		return err
	}
	changed := previous != content
	if changed {
		file, err := os.CreateTemp(m.dir, ".web2term-service-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err = file.WriteString(content); err == nil {
			err = file.Chmod(0o644)
		}
		if err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		if err := os.Rename(file.Name(), filepath.Join(m.dir, name)); err != nil {
			return err
		}
	}
	if _, err := m.command("daemon-reload"); err != nil {
		return err
	}
	if _, err := m.command("enable", name); err != nil {
		return err
	}
	state, err := m.command("show", "--property=ActiveState", "--value", name)
	if err != nil {
		return err
	}
	if strings.TrimSpace(state) == "active" && !changed {
		return nil // enabling an unchanged running service must not drop its PTYs
	}
	if _, err := m.command("stop", name); err != nil {
		return err
	}
	// Migrate a manually launched worker before systemd starts its replacement.
	// Stop uses the authenticated local socket and singleton lock, never an old PID.
	if _, err := m.stop(spec.config); err != nil {
		return err
	}
	if _, err := m.command("reset-failed", name); err != nil {
		return err
	}
	_, err = m.command("start", name)
	return err
}

func (m manager) disable(uid string) error {
	name, err := unitName(uid)
	if err != nil {
		return err
	}
	previous, err := m.managedFile(name)
	if err != nil || previous == "" {
		return err
	}
	_, err = m.command("disable", "--now", name)
	return err
}
