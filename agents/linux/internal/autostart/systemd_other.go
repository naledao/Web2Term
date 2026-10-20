//go:build !linux

package autostart

import (
	"errors"
	"io"
)

func Run(string, string, io.Reader, io.Writer) error {
	return errors.New("开机自启仅支持运行 systemd 的 Linux 主机")
}

func Privileged([]string, io.Writer) error {
	return errors.New("开机自启仅支持运行 systemd 的 Linux 主机")
}
