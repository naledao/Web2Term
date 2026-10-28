package config

import (
	"errors"
	"net"
	"net/mail"
	"os"
	"strconv"
	"strings"
)

type Config struct {
	Addr, DBPath, JWTSecret string
	ReleaseNotesAdminToken  string
	SMTP                    SMTP
}

type SMTP struct {
	Host, Port, Username, Password, From, Mode string
}

func Load() (Config, error) {
	c := Config{Addr: ":10088", DBPath: "data/web2term.db", SMTP: SMTP{Port: "465", Mode: "tls"}}
	for name, target := range map[string]*string{
		"WEB2TERM_ADDR": &c.Addr, "WEB2TERM_DB_PATH": &c.DBPath, "WEB2TERM_JWT_SECRET": &c.JWTSecret,
		"RELEASE_NOTES_ADMIN_TOKEN": &c.ReleaseNotesAdminToken,
		"SMTP_HOST":                 &c.SMTP.Host, "SMTP_PORT": &c.SMTP.Port, "SMTP_USERNAME": &c.SMTP.Username,
		"SMTP_PASSWORD": &c.SMTP.Password, "SMTP_FROM": &c.SMTP.From, "SMTP_MODE": &c.SMTP.Mode,
	} {
		if value, ok := os.LookupEnv(name); ok {
			*target = value
		}
	}
	if c.SMTP.From == "" {
		c.SMTP.From = c.SMTP.Username
	}
	return c, c.Validate()
}

func (c Config) Validate() error {
	_, port, err := net.SplitHostPort(c.Addr)
	if err != nil {
		return errors.New("WEB2TERM_ADDR must be host:port, for example :10088")
	}
	p, err := strconv.Atoi(port)
	if err != nil || p < 1 || p > 65535 {
		return errors.New("invalid WEB2TERM_ADDR port")
	}
	if strings.TrimSpace(c.DBPath) == "" || c.DBPath == ":memory:" || strings.HasPrefix(c.DBPath, "file:") {
		return errors.New("WEB2TERM_DB_PATH must be a persistent filesystem path")
	}
	if len(c.JWTSecret) < 32 {
		return errors.New("WEB2TERM_JWT_SECRET must contain at least 32 bytes of random secret data")
	}
	if strings.TrimSpace(c.ReleaseNotesAdminToken) != c.ReleaseNotesAdminToken {
		return errors.New("RELEASE_NOTES_ADMIN_TOKEN must not contain leading or trailing whitespace")
	}
	if c.SMTP.Host == "" && c.SMTP.Username == "" && c.SMTP.Password == "" && c.SMTP.From == "" {
		return nil
	}
	if c.SMTP.Host == "" || strings.ContainsAny(c.SMTP.Host, "\r\n /:") || c.SMTP.Username == "" || c.SMTP.Password == "" {
		return errors.New("SMTP_HOST, SMTP_USERNAME and SMTP_PASSWORD must be set together")
	}
	from, err := mail.ParseAddress(c.SMTP.From)
	if err != nil || from.Address != c.SMTP.From || strings.ContainsAny(c.SMTP.From, "\r\n") {
		return errors.New("SMTP_FROM must be a plain email address")
	}
	p, err = strconv.Atoi(c.SMTP.Port)
	if err != nil || p < 1 || p > 65535 {
		return errors.New("invalid SMTP_PORT")
	}
	if c.SMTP.Mode != "tls" && c.SMTP.Mode != "starttls" {
		return errors.New("SMTP_MODE must be tls or starttls")
	}
	return nil
}
