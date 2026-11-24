package auth

import (
	"context"
	"crypto/tls"
	"fmt"
	"io"
	"mime"
	"mime/quotedprintable"
	"net"
	"net/smtp"
	"strings"
	"time"

	"web2term/backend/internal/config"
)

type SMTPMailer struct{ Config config.SMTP }

func (m SMTPMailer) SendCode(ctx context.Context, email, code string) error {
	return m.Send(ctx, email, "Web2Term 登录验证码",
		"您的 Web2Term 登录验证码为："+code+"\n\n验证码 10 分钟内有效，只能使用一次。请勿向他人提供验证码。\n")
}

// Send delivers one plain-text UTF-8 message. The recipient and subject are
// header values and must be single-line; the body may be any text.
func (m SMTPMailer) Send(ctx context.Context, to, subject, body string) error {
	c := m.Config
	if c.Host == "" {
		return fmt.Errorf("SMTP is not configured")
	}
	if strings.ContainsAny(to, "\r\n<>") || strings.ContainsAny(subject, "\r\n") {
		return fmt.Errorf("invalid mail header")
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	conn, err := (&net.Dialer{}).DialContext(ctx, "tcp", net.JoinHostPort(c.Host, c.Port))
	if err != nil {
		return err
	}
	defer conn.Close()
	deadline, _ := ctx.Deadline()
	if err := conn.SetDeadline(deadline); err != nil {
		return err
	}
	tlsConfig := &tls.Config{ServerName: c.Host, MinVersion: tls.VersionTLS12}
	if c.Mode == "tls" {
		tlsConn := tls.Client(conn, tlsConfig)
		if err := tlsConn.HandshakeContext(ctx); err != nil {
			return err
		}
		conn = tlsConn
	}
	client, err := smtp.NewClient(conn, c.Host)
	if err != nil {
		return err
	}
	defer client.Close()
	if c.Mode == "starttls" {
		if err := client.StartTLS(tlsConfig); err != nil {
			return err
		}
	}
	if err := client.Auth(smtp.PlainAuth("", c.Username, c.Password, c.Host)); err != nil {
		return err
	}
	if err := client.Mail(c.From); err != nil {
		return err
	}
	if err := client.Rcpt(to); err != nil {
		return err
	}
	writer, err := client.Data()
	if err != nil {
		return err
	}
	header := fmt.Sprintf("From: Web2Term <%s>\r\nTo: <%s>\r\nSubject: %s\r\nDate: %s\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=UTF-8\r\nContent-Transfer-Encoding: quoted-printable\r\n\r\n",
		c.From, to, mime.QEncoding.Encode("UTF-8", subject), time.Now().UTC().Format(time.RFC1123Z))
	if _, err := io.WriteString(writer, header); err != nil {
		return err
	}
	// Quoted-printable keeps every line under the SMTP limit, even for long user text.
	encoded := quotedprintable.NewWriter(writer)
	if _, err := io.WriteString(encoded, strings.ReplaceAll(body, "\n", "\r\n")); err != nil {
		return err
	}
	if err := encoded.Close(); err != nil {
		return err
	}
	if err := writer.Close(); err != nil {
		return err
	}
	_ = client.Quit()
	return nil
}
