package config

import (
	"strings"
	"testing"
)

func TestStandaloneEnvironment(t *testing.T) {
	t.Setenv("WEB2TERM_ADDR", "127.0.0.1:10088")
	t.Setenv("WEB2TERM_DB_PATH", "custom/devices.db")
	t.Setenv("WEB2TERM_JWT_SECRET", strings.Repeat("x", 32))
	t.Setenv("RELEASE_NOTES_ADMIN_TOKEN", "fixture-admin-token")
	t.Setenv("SMTP_HOST", "smtp.example.invalid")
	t.Setenv("SMTP_USERNAME", "sender@example.invalid")
	t.Setenv("SMTP_PASSWORD", "fixture")
	t.Setenv("SMTP_FROM", "")
	c, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if c.Addr != "127.0.0.1:10088" || c.DBPath != "custom/devices.db" || c.SMTP.From != c.SMTP.Username || c.ReleaseNotesAdminToken != "fixture-admin-token" {
		t.Fatal("environment not applied")
	}
}

func TestReleaseNotesAdminTokenValidation(t *testing.T) {
	c := Config{Addr: ":10088", DBPath: "data/backend.db", JWTSecret: strings.Repeat("x", 32)}
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	c.ReleaseNotesAdminToken = "fixture-token"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
	for _, token := range []string{" token", "token\n", "\t"} {
		c.ReleaseNotesAdminToken = token
		if err := c.Validate(); err == nil {
			t.Fatal("accepted whitespace around an admin token")
		}
	}
}

func TestRejectsWeakSecretAndPlaintextMail(t *testing.T) {
	c := Config{Addr: ":10088", DBPath: "data/backend.db"}
	if c.Validate() == nil {
		t.Fatal("missing JWT secret was accepted")
	}
	c.JWTSecret = strings.Repeat("x", 32)
	c.SMTP = SMTP{Host: "smtp.example.invalid", Port: "465", Username: "sender@example.invalid", Password: "fixture", From: "sender@example.invalid", Mode: "none"}
	if c.Validate() == nil {
		t.Fatal("plaintext SMTP was accepted")
	}
	c.SMTP.Mode = "tls"
	if err := c.Validate(); err != nil {
		t.Fatal(err)
	}
}
