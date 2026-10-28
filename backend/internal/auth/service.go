package auth

import (
	"context"
	"crypto/hmac"
	"crypto/rand"
	"crypto/sha256"
	"database/sql"
	"encoding/hex"
	"errors"
	"fmt"
	"math/big"
	"net/http"
	"net/mail"
	"strconv"
	"strings"
	"time"

	"github.com/golang-jwt/jwt/v5"
	"web2term/backend/internal/store"
)

type Failure struct {
	Status        int
	Code, Message string
}

func (e *Failure) Error() string { return e.Code }
func FailureOf(err error) *Failure {
	var failure *Failure
	if errors.As(err, &failure) {
		return failure
	}
	return &Failure{500, "INTERNAL_ERROR", "服务暂时不可用"}
}

type Mailer interface {
	SendCode(context.Context, string, string) error
}
type Accounts interface {
	ReserveCode(context.Context, string, []byte, int64) error
	InvalidateCode(context.Context, string, []byte) error
	LoginWithCode(context.Context, string, []byte, int64, string) (store.User, error)
	UserByID(context.Context, int64) (store.User, error)
}

type Service struct {
	accounts Accounts
	mailer   Mailer
	key      []byte
	now      func() time.Time
}
type LoginResponse struct {
	AccessToken      string     `json:"accessToken"`
	TokenType        string     `json:"tokenType"`
	ExpiresInSeconds int64      `json:"expiresInSeconds"`
	User             store.User `json:"user"`
}
type claims struct {
	PublicID string `json:"publicId"`
	Version  int    `json:"ver"`
	jwt.RegisteredClaims
}

func New(accounts Accounts, mailer Mailer, secret string) (*Service, error) {
	if len(secret) < 32 {
		return nil, errors.New("JWT secret must contain at least 32 bytes")
	}
	return &Service{accounts: accounts, mailer: mailer, key: []byte(secret), now: time.Now}, nil
}

func normalizeEmail(raw string) (string, error) {
	email := strings.ToLower(strings.TrimSpace(raw))
	address, err := mail.ParseAddress(email)
	if err != nil || len(email) > 254 || address.Address != email || !strings.Contains(email, "@") || strings.ContainsAny(email, "\r\n") {
		return "", &Failure{400, "INVALID_EMAIL", "邮箱格式不正确"}
	}
	return email, nil
}

func (s *Service) codeHash(email, code string) []byte {
	mac := hmac.New(sha256.New, s.key)
	mac.Write([]byte("web2term-login-code\x00" + email + "\x00" + code))
	return mac.Sum(nil)
}

func (s *Service) SendCode(ctx context.Context, raw string) error {
	email, err := normalizeEmail(raw)
	if err != nil {
		return err
	}
	value, err := rand.Int(rand.Reader, big.NewInt(1_000_000))
	if err != nil {
		return err
	}
	code := fmt.Sprintf("%06d", value.Int64())
	hash := s.codeHash(email, code)
	if err := s.accounts.ReserveCode(ctx, email, hash, s.now().Unix()); err != nil {
		if errors.Is(err, store.ErrCodeTooFrequent) {
			return &Failure{429, "LOGIN_CODE_TOO_FREQUENT", "验证码发送过于频繁"}
		}
		return err
	}
	if s.mailer == nil {
		err = errors.New("SMTP is not configured")
	} else {
		err = s.mailer.SendCode(ctx, email, code)
	}
	if err != nil {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		_ = s.accounts.InvalidateCode(cleanupCtx, email, hash)
		return &Failure{http.StatusServiceUnavailable, "LOGIN_CODE_SEND_FAILED", "验证码邮件发送失败，请稍后重试"}
	}
	return nil
}

func (s *Service) Login(ctx context.Context, raw, code string) (LoginResponse, error) {
	email, err := normalizeEmail(raw)
	if err != nil {
		return LoginResponse{}, err
	}
	if len(code) != 6 || strings.IndexFunc(code, func(r rune) bool { return r < '0' || r > '9' }) != -1 {
		return LoginResponse{}, &Failure{400, "INVALID_LOGIN_CODE", "验证码必须是 6 位数字"}
	}
	publicBytes := make([]byte, 16)
	if _, err := rand.Read(publicBytes); err != nil {
		return LoginResponse{}, err
	}
	u, err := s.accounts.LoginWithCode(ctx, email, s.codeHash(email, code), s.now().Unix(), "usr_"+hex.EncodeToString(publicBytes))
	if errors.Is(err, store.ErrCodeIncorrect) {
		return LoginResponse{}, &Failure{401, "LOGIN_CODE_INCORRECT", "验证码错误或已过期"}
	}
	if errors.Is(err, store.ErrUserDisabled) {
		return LoginResponse{}, &Failure{403, "USER_DISABLED", "账号已被禁用"}
	}
	if err != nil {
		return LoginResponse{}, err
	}
	now := s.now()
	c := claims{PublicID: u.PublicID, Version: u.TokenVersion, RegisteredClaims: jwt.RegisteredClaims{
		Issuer: "web2term", Audience: jwt.ClaimStrings{"web2term"}, Subject: strconv.FormatInt(u.ID, 10),
		IssuedAt: jwt.NewNumericDate(now), ExpiresAt: jwt.NewNumericDate(now.Add(24 * time.Hour)),
	}}
	token, err := jwt.NewWithClaims(jwt.SigningMethodHS256, c).SignedString(s.key)
	if err != nil {
		return LoginResponse{}, err
	}
	return LoginResponse{AccessToken: token, TokenType: "Bearer", ExpiresInSeconds: 86400, User: u}, nil
}

func (s *Service) Introspect(ctx context.Context, authorization string) (int64, error) {
	deny := &Failure{401, "UNAUTHORIZED", "当前请求尚未认证"}
	parts := strings.Fields(authorization)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") || len(parts[1]) > 16384 {
		return 0, deny
	}
	var c claims
	token, err := jwt.ParseWithClaims(parts[1], &c, func(*jwt.Token) (any, error) { return s.key, nil },
		jwt.WithValidMethods([]string{"HS256"}), jwt.WithIssuer("web2term"), jwt.WithAudience("web2term"),
		jwt.WithExpirationRequired(), jwt.WithIssuedAt(), jwt.WithTimeFunc(s.now))
	if err != nil || !token.Valid {
		return 0, deny
	}
	id, err := strconv.ParseInt(c.Subject, 10, 64)
	if err != nil || id <= 0 {
		return 0, deny
	}
	u, err := s.accounts.UserByID(ctx, id)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return 0, err
	}
	if err != nil || !u.Enabled || u.PublicID != c.PublicID || u.TokenVersion != c.Version {
		return 0, deny
	}
	return u.ID, nil
}
