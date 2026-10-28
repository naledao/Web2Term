package store

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"errors"
)

var (
	ErrCodeIncorrect   = errors.New("login code incorrect or expired")
	ErrCodeTooFrequent = errors.New("login code requested too frequently")
	ErrUserDisabled    = errors.New("user disabled")
)

type User struct {
	ID           int64   `json:"-"`
	PublicID     string  `json:"publicId"`
	Email        string  `json:"email"`
	Nickname     string  `json:"nickname"`
	AvatarURL    *string `json:"avatarUrl"`
	Role         string  `json:"role"`
	Enabled      bool    `json:"-"`
	TokenVersion int     `json:"-"`
}

func (s *Store) ReserveCode(ctx context.Context, email string, hash []byte, now int64) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var sent, window int64
	var count int
	err = tx.QueryRowContext(ctx, "SELECT sent_at, window_started, send_count FROM login_code WHERE email = ?", email).Scan(&sent, &window, &count)
	if err != nil && !errors.Is(err, sql.ErrNoRows) {
		return err
	}
	if err == nil && (now < sent+60 || (now < window+3600 && count >= 10)) {
		return ErrCodeTooFrequent
	}
	if now >= window+3600 || errors.Is(err, sql.ErrNoRows) {
		window, count = now, 0
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO login_code(email, code_hash, expires_at, sent_at, window_started, send_count)
		VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO UPDATE SET code_hash = excluded.code_hash,
		expires_at = excluded.expires_at, sent_at = excluded.sent_at, attempts = 0,
		window_started = excluded.window_started, send_count = excluded.send_count`, email, hash, now+600, now, window, count+1)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "DELETE FROM login_code WHERE expires_at < ? AND sent_at < ?", now-86400, now-86400); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) InvalidateCode(ctx context.Context, email string, hash []byte) error {
	_, err := s.db.ExecContext(ctx, "UPDATE login_code SET expires_at = 0, attempts = 5 WHERE email = ? AND code_hash = ?", email, hash)
	return err
}

// Verification, one-time consumption and account creation are one transaction.
func (s *Store) LoginWithCode(ctx context.Context, email string, hash []byte, now int64, publicID string) (User, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return User{}, err
	}
	defer tx.Rollback()
	var expected []byte
	var expiry int64
	var attempts int
	err = tx.QueryRowContext(ctx, "SELECT code_hash, expires_at, attempts FROM login_code WHERE email = ?", email).Scan(&expected, &expiry, &attempts)
	if errors.Is(err, sql.ErrNoRows) {
		return User{}, ErrCodeIncorrect
	}
	if err != nil {
		return User{}, err
	}
	if now >= expiry || attempts >= 5 {
		return User{}, ErrCodeIncorrect
	}
	if subtle.ConstantTimeCompare(expected, hash) != 1 {
		if _, err := tx.ExecContext(ctx, "UPDATE login_code SET attempts = attempts + 1 WHERE email = ?", email); err != nil {
			return User{}, err
		}
		if err := tx.Commit(); err != nil {
			return User{}, err
		}
		return User{}, ErrCodeIncorrect
	}
	// Preserve resend/hourly quotas after consuming the one-time code.
	if _, err := tx.ExecContext(ctx, "UPDATE login_code SET code_hash = zeroblob(32), expires_at = 0, attempts = 5 WHERE email = ?", email); err != nil {
		return User{}, err
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_account(public_id, email, nickname) VALUES (?, ?, ?)
		ON CONFLICT(email) DO NOTHING`, publicID, email, email); err != nil {
		return User{}, err
	}
	u, err := scanUser(tx.QueryRowContext(ctx, "SELECT "+userColumns+" FROM user_account WHERE email = ?", email))
	if err != nil {
		return User{}, err
	}
	if err := tx.Commit(); err != nil {
		return User{}, err
	}
	if !u.Enabled {
		return User{}, ErrUserDisabled
	}
	return u, nil
}

const userColumns = "id, public_id, email, nickname, avatar_url, role, enabled, token_version"

func scanUser(row *sql.Row) (User, error) {
	var u User
	err := row.Scan(&u.ID, &u.PublicID, &u.Email, &u.Nickname, &u.AvatarURL, &u.Role, &u.Enabled, &u.TokenVersion)
	return u, err
}

func (s *Store) UserByID(ctx context.Context, id int64) (User, error) {
	return scanUser(s.db.QueryRowContext(ctx, "SELECT "+userColumns+" FROM user_account WHERE id = ?", id))
}
