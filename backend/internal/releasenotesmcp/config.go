// Package releasenotesmcp exposes the backend's release-note administration API
// as local MCP tools. It never needs the backend database or a user JWT.
package releasenotesmcp

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/url"
	"os"
	"runtime"
	"strings"
)

// Config belongs in a private file outside the repository. Do not log it.
type Config struct {
	BaseURL        string `json:"baseUrl"`
	AdminToken     string `json:"adminToken"`
	TimeoutSeconds int    `json:"timeoutSeconds"`
}

// LoadConfig deliberately returns fixed errors: a parser error could include a
// fragment of the secret, and a filesystem error could include a sensitive path.
func LoadConfig(filename string) (Config, error) {
	var cfg Config
	f, err := os.Open(filename)
	if err != nil {
		return cfg, errors.New("无法打开 MCP 配置文件")
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 32*1024 {
		return cfg, errors.New("MCP 配置必须是小于 32 KiB 的普通 JSON 文件")
	}
	if runtime.GOOS != "windows" && info.Mode().Perm()&0077 != 0 {
		return cfg, errors.New("MCP 配置含有令牌，请先执行 chmod 600 限制权限")
	}
	raw, err := io.ReadAll(io.LimitReader(f, 32*1024+1))
	if err != nil || len(raw) > 32*1024 {
		return cfg, errors.New("无法读取 MCP 配置文件")
	}
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if dec.Decode(&cfg) != nil || dec.Decode(new(any)) != io.EOF {
		return Config{}, errors.New("MCP 配置 JSON 无效或包含未知字段")
	}
	return normalizeConfig(cfg)
}

func normalizeConfig(cfg Config) (Config, error) {
	u, err := url.Parse(cfg.BaseURL)
	if err != nil || u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" ||
		u.User != nil || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" || u.Opaque != "" ||
		strings.Contains(cfg.BaseURL, "#") || strings.TrimSpace(cfg.BaseURL) != cfg.BaseURL {
		return Config{}, errors.New("baseUrl 必须是无账号、查询参数或片段的 HTTP(S) 地址")
	}
	if len(cfg.AdminToken) < 32 || len(cfg.AdminToken) > 4096 {
		return Config{}, errors.New("adminToken 必须包含 32 到 4096 个可打印 ASCII 字符")
	}
	for _, ch := range cfg.AdminToken {
		if ch <= 32 || ch >= 127 {
			return Config{}, errors.New("adminToken 不能包含空白或非 ASCII 字符")
		}
	}
	if cfg.TimeoutSeconds == 0 {
		cfg.TimeoutSeconds = 20
	}
	if cfg.TimeoutSeconds < 1 || cfg.TimeoutSeconds > 120 {
		return Config{}, errors.New("timeoutSeconds 必须在 1 到 120 之间")
	}
	cfg.BaseURL = strings.TrimRight(cfg.BaseURL, "/")
	return cfg, nil
}
