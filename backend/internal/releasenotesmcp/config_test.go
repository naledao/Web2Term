package releasenotesmcp

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

const testToken = "mcp-test-token-abcdefghijklmnopqrstuvwxyz0123456789"

func TestLoadConfig(t *testing.T) {
	file := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(file, []byte(`{"baseUrl":"http://127.0.0.1:10088/","adminToken":"`+testToken+`"}`), 0600); err != nil {
		t.Fatal(err)
	}
	cfg, err := LoadConfig(file)
	if err != nil || cfg.BaseURL != "http://127.0.0.1:10088" || cfg.TimeoutSeconds != 20 || cfg.AdminToken != testToken {
		t.Fatal("valid private config was not loaded")
	}
	for _, raw := range []string{
		`{"baseUrl":"https://example.com","adminToken":"` + testToken + `","unexpected":true}`,
		`{"baseUrl":"https://example.com","adminToken":"` + testToken + `"} {}`,
		`{"adminToken":"` + testToken + ``,
	} {
		if err := os.WriteFile(file, []byte(raw), 0600); err != nil {
			t.Fatal(err)
		}
		_, err := LoadConfig(file)
		if err == nil || strings.Contains(err.Error(), testToken) {
			t.Fatal("invalid config accepted or token leaked")
		}
	}
}

func TestConfigRejectsInvalidValues(t *testing.T) {
	for _, base := range []string{"", "file:///etc/passwd", "https://user:password@example.com", "https://example.com?x=1", "https://example.com#part", "https://example.com#", "https://example.com ", "https://example.com:invalid"} {
		if _, err := NewClient(Config{BaseURL: base, AdminToken: testToken}); err == nil {
			t.Errorf("invalid base URL accepted: %q", base)
		}
	}
	for _, token := range []string{"", "short", testToken + "\n", testToken + "中文"} {
		if _, err := NewClient(Config{BaseURL: "https://example.com", AdminToken: token}); err == nil {
			t.Fatal("invalid token accepted")
		}
	}
	for _, timeout := range []int{-1, 121} {
		if _, err := NewClient(Config{BaseURL: "https://example.com", AdminToken: testToken, TimeoutSeconds: timeout}); err == nil {
			t.Fatal("invalid timeout accepted")
		}
	}
}

func TestConfigRequiresPrivateUnixPermissions(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Windows ACL is provisioned separately")
	}
	file := filepath.Join(t.TempDir(), "mcp.json")
	if err := os.WriteFile(file, []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Chmod(file, 0644); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadConfig(file); err == nil || !strings.Contains(err.Error(), "chmod 600") {
		t.Fatal("public config permissions accepted")
	}
}
