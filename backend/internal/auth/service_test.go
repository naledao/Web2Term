package auth

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"web2term/backend/internal/store"
)

type capturedMail struct {
	email, code string
	fail        bool
}

func (m *capturedMail) SendCode(_ context.Context, email, code string) error {
	if m.fail {
		return errors.New("private SMTP transport failure")
	}
	m.email, m.code = email, code
	return nil
}

func setupAuth(t *testing.T) (*Service, *store.Store, *capturedMail) {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "auth.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	mail := &capturedMail{}
	svc, err := New(db, mail, strings.Repeat("test-secret-", 4))
	if err != nil {
		t.Fatal(err)
	}
	fixed := time.Date(2026, 10, 28, 12, 0, 0, 0, time.UTC)
	svc.now = func() time.Time { return fixed }
	return svc, db, mail
}

func TestCodeLoginAndJWTContract(t *testing.T) {
	svc, _, mail := setupAuth(t)
	ctx := context.Background()
	if err := svc.SendCode(ctx, " Fixture@Example.invalid "); err != nil {
		t.Fatal(err)
	}
	if mail.email != "fixture@example.invalid" || len(mail.code) != 6 {
		t.Fatal("invalid email/code normalization")
	}
	if err := svc.SendCode(ctx, mail.email); FailureOf(err).Status != 429 {
		t.Fatalf("resend cooldown: %v", err)
	}
	result, err := svc.Login(ctx, mail.email, mail.code)
	if err != nil {
		t.Fatal(err)
	}
	if result.TokenType != "Bearer" || result.ExpiresInSeconds != 86400 || result.User.PublicID == "" || result.User.Role != "USER" || result.User.Nickname != mail.email || result.User.AvatarURL != nil {
		t.Fatalf("login shape: %+v", result.User)
	}
	id, err := svc.Introspect(ctx, "Bearer "+result.AccessToken)
	if err != nil || id != result.User.ID {
		t.Fatalf("JWT identity: %d %v", id, err)
	}
	if _, err := svc.Login(ctx, mail.email, mail.code); FailureOf(err).Code != "LOGIN_CODE_INCORRECT" {
		t.Fatalf("reused code: %v", err)
	}
	if _, err := svc.Introspect(ctx, "Bearer "+result.AccessToken+"tampered"); FailureOf(err).Status != 401 {
		t.Fatalf("tampered token: %v", err)
	}
	old := svc.now()
	svc.now = func() time.Time { return old.Add(24 * time.Hour) }
	if _, err := svc.Introspect(ctx, "Bearer "+result.AccessToken); FailureOf(err).Status != 401 {
		t.Fatalf("expired token: %v", err)
	}
}

func TestWrongCodeAttemptsAndDeliveryFailure(t *testing.T) {
	svc, _, mail := setupAuth(t)
	ctx := context.Background()
	if err := svc.SendCode(ctx, "fixture@example.invalid"); err != nil {
		t.Fatal(err)
	}
	wrong := "000000"
	if mail.code == wrong {
		wrong = "000001"
	}
	for i := 0; i < 5; i++ {
		if _, err := svc.Login(ctx, mail.email, wrong); FailureOf(err).Code != "LOGIN_CODE_INCORRECT" {
			t.Fatalf("incorrect code: %v", err)
		}
	}
	if _, err := svc.Login(ctx, mail.email, mail.code); FailureOf(err).Code != "LOGIN_CODE_INCORRECT" {
		t.Fatalf("locked code accepted: %v", err)
	}
	mail.fail = true
	err := svc.SendCode(ctx, "other@example.invalid")
	if FailureOf(err).Code != "LOGIN_CODE_SEND_FAILED" || strings.Contains(err.Error(), "private") {
		t.Fatalf("SMTP error leak: %v", err)
	}
	if _, err := svc.Login(ctx, "other@example.invalid", "000000"); FailureOf(err).Code != "LOGIN_CODE_INCORRECT" {
		t.Fatalf("failed delivery code: %v", err)
	}
}

func TestJWTAlgorithmAndAudienceAreEnforced(t *testing.T) {
	svc, _, mail := setupAuth(t)
	ctx := context.Background()
	if err := svc.SendCode(ctx, "fixture@example.invalid"); err != nil {
		t.Fatal(err)
	}
	login, err := svc.Login(ctx, mail.email, mail.code)
	if err != nil {
		t.Fatal(err)
	}
	var original claims
	if _, _, err := jwt.NewParser().ParseUnverified(login.AccessToken, &original); err != nil {
		t.Fatal(err)
	}
	for _, change := range []string{"algorithm", "audience", "issuer", "version", "missing expiry"} {
		c := original
		method := jwt.SigningMethodHS256
		switch change {
		case "algorithm":
			method = jwt.SigningMethodHS384
		case "audience":
			c.Audience = jwt.ClaimStrings{"another-app"}
		case "issuer":
			c.Issuer = "another-issuer"
		case "version":
			c.Version++
		case "missing expiry":
			c.ExpiresAt = nil
		}
		raw, err := jwt.NewWithClaims(method, c).SignedString(svc.key)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Introspect(ctx, "Bearer "+raw); FailureOf(err).Status != 401 {
			t.Fatalf("accepted %s: %v", change, err)
		}
	}
}

func TestExpiredCodeAndStableAccountAcrossLogins(t *testing.T) {
	svc, _, mail := setupAuth(t)
	ctx := context.Background()
	if err := svc.SendCode(ctx, "fixture@example.invalid"); err != nil {
		t.Fatal(err)
	}
	old := svc.now()
	svc.now = func() time.Time { return old.Add(10 * time.Minute) }
	if _, err := svc.Login(ctx, mail.email, mail.code); FailureOf(err).Code != "LOGIN_CODE_INCORRECT" {
		t.Fatalf("expired code: %v", err)
	}
	if err := svc.SendCode(ctx, mail.email); err != nil {
		t.Fatal(err)
	}
	first, err := svc.Login(ctx, mail.email, mail.code)
	if err != nil {
		t.Fatal(err)
	}
	svc.now = func() time.Time { return old.Add(11 * time.Minute) }
	if err := svc.SendCode(ctx, mail.email); err != nil {
		t.Fatal(err)
	}
	second, err := svc.Login(ctx, mail.email, mail.code)
	if err != nil || first.User.ID != second.User.ID || first.User.PublicID != second.User.PublicID {
		t.Fatalf("account identity changed: %v", err)
	}
}

func TestConsumedCodeKeepsResendAndHourlyQuotas(t *testing.T) {
	svc, _, mail := setupAuth(t)
	ctx := context.Background()
	start := svc.now()
	for i := 0; i < 10; i++ {
		current := start.Add(time.Duration(i) * 61 * time.Second)
		svc.now = func() time.Time { return current }
		if err := svc.SendCode(ctx, "fixture@example.invalid"); err != nil {
			t.Fatal(err)
		}
		if _, err := svc.Login(ctx, mail.email, mail.code); err != nil {
			t.Fatal(err)
		}
		if err := svc.SendCode(ctx, mail.email); FailureOf(err).Status != 429 {
			t.Fatalf("successful login reset resend limit: %v", err)
		}
	}
	svc.now = func() time.Time { return start.Add(610 * time.Second) }
	if err := svc.SendCode(ctx, mail.email); FailureOf(err).Status != 429 {
		t.Fatalf("successful logins reset hourly limit: %v", err)
	}
	svc.now = func() time.Time { return start.Add(time.Hour) }
	if err := svc.SendCode(ctx, mail.email); err != nil {
		t.Fatalf("hourly window did not reset: %v", err)
	}
}

func TestJWTUsesPersistentSigningSecretAcrossServiceRestarts(t *testing.T) {
	svc, db, mail := setupAuth(t)
	ctx := context.Background()
	if err := svc.SendCode(ctx, "fixture@example.invalid"); err != nil {
		t.Fatal(err)
	}
	login, err := svc.Login(ctx, mail.email, mail.code)
	if err != nil {
		t.Fatal(err)
	}
	restarted, err := New(db, mail, string(svc.key))
	if err != nil {
		t.Fatal(err)
	}
	restarted.now = svc.now
	if id, err := restarted.Introspect(ctx, "Bearer "+login.AccessToken); err != nil || id != login.User.ID {
		t.Fatalf("token invalid after service recreation: %v", err)
	}
	rotated, err := New(db, mail, strings.Repeat("another-secret-", 4))
	if err != nil {
		t.Fatal(err)
	}
	rotated.now = svc.now
	if _, err := rotated.Introspect(ctx, "Bearer "+login.AccessToken); FailureOf(err).Status != 401 {
		t.Fatalf("old token survived signing key rotation: %v", err)
	}
}
