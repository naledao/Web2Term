package store

import (
	"context"
	"database/sql"
	_ "embed"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schema string

//go:embed auth_schema.sql
var authSchema string

const nowSQL = "strftime('%Y-%m-%dT%H:%M:%fZ', 'now')"

type Store struct{ db *sql.DB }

type AuthState struct {
	UserID  int64
	Enabled bool
}

// Keep the JSON field names, nulls and numeric statuses used by both clients.
type Device struct {
	DeviceID                 string  `json:"deviceId"`
	DeviceName               string  `json:"deviceName"`
	Enabled                  int     `json:"enabled"`
	OnlineStatus             int     `json:"onlineStatus"`
	LastConnectedAt          *string `json:"lastConnectedAt"`
	LastHeartbeatAt          *string `json:"lastHeartbeatAt"`
	LastDisconnectedAt       *string `json:"lastDisconnectedAt"`
	TerminalConnectionStatus int     `json:"terminalConnectionStatus"`
	TerminalSessionID        *string `json:"terminalSessionId"`
	DesktopClientID          *string `json:"desktopClientId"`
	TerminalRequestedAt      *string `json:"terminalRequestedAt"`
	TerminalConnectedAt      *string `json:"terminalConnectedAt"`
	TerminalDisconnectedAt   *string `json:"terminalDisconnectedAt"`
	TerminalError            *string `json:"terminalError"`
	CreatedAt                string  `json:"createdAt"`
	UpdatedAt                string  `json:"updatedAt"`
}

func Open(ctx context.Context, path string) (*Store, error) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, errors.New("invalid database path")
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0700); err != nil {
		return nil, errors.New("cannot create database directory")
	}
	// A filesystem path is converted to a URI; '?' and '#' in it are never DSN options.
	uriPath := filepath.ToSlash(absolute)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	u := url.URL{Scheme: "file", Path: uriPath}
	q := url.Values{"_pragma": {"busy_timeout(5000)", "journal_mode(WAL)", "foreign_keys(1)"}}
	u.RawQuery = q.Encode()
	db, err := sql.Open("sqlite", u.String())
	if err != nil {
		return nil, errors.New("cannot open SQLite database")
	}
	// Serialize writes and keep connection-local pragmas consistent.
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	if err := initialize(ctx, db); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

func initialize(ctx context.Context, db *sql.DB) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return errors.New("cannot begin SQLite initialization")
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return errors.New("cannot read SQLite schema version")
	}
	if version > 2 {
		return fmt.Errorf("SQLite schema version %d is newer than this backend supports", version)
	}
	if version == 0 {
		if _, err := tx.ExecContext(ctx, schema); err != nil {
			return errors.New("cannot initialize SQLite schema")
		}
	}
	if version < 2 {
		if _, err := tx.ExecContext(ctx, authSchema); err != nil {
			return errors.New("cannot initialize local account schema")
		}
		if _, err := tx.ExecContext(ctx, "PRAGMA user_version = 2"); err != nil {
			return errors.New("cannot save SQLite schema version")
		}
	}
	// Live connections belong to this process; a restart invalidates previous status.
	if _, err := tx.ExecContext(ctx, `UPDATE user_device SET online_status = 0,
		last_disconnected_at = `+nowSQL+`, updated_at = `+nowSQL+` WHERE online_status = 1`); err != nil {
		return errors.New("cannot reset stale device status")
	}
	if err := tx.Commit(); err != nil {
		return errors.New("cannot commit SQLite initialization")
	}
	return nil
}

func (s *Store) Close() error { return s.db.Close() }

func (s *Store) Auth(ctx context.Context, id string) (AuthState, bool, error) {
	var state AuthState
	err := s.db.QueryRowContext(ctx, "SELECT user_id, enabled FROM user_device WHERE device_id = ?", id).
		Scan(&state.UserID, &state.Enabled)
	if errors.Is(err, sql.ErrNoRows) {
		return AuthState{}, false, nil
	}
	return state, err == nil, err
}

func (s *Store) Connect(ctx context.Context, userID int64, id, name string) (bool, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return false, err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, `INSERT INTO user_device(user_id, device_id, device_name)
		VALUES (?, ?, ?) ON CONFLICT(device_id) DO NOTHING`, userID, id, name); err != nil {
		return false, err
	}
	result, err := tx.ExecContext(ctx, `UPDATE user_device SET online_status = 1,
		last_connected_at = `+nowSQL+`, last_heartbeat_at = `+nowSQL+`, updated_at = `+nowSQL+`
		WHERE user_id = ? AND device_id = ? AND enabled = 1`, userID, id)
	if err != nil {
		return false, err
	}
	n, err := result.RowsAffected()
	if err != nil {
		return false, err
	}
	if err := tx.Commit(); err != nil {
		return false, err
	}
	return n == 1, nil
}

func (s *Store) Heartbeat(ctx context.Context, userID int64, id string) (bool, error) {
	return s.update(ctx, `UPDATE user_device SET last_heartbeat_at = `+nowSQL+`, updated_at = `+nowSQL+`
		WHERE user_id = ? AND device_id = ? AND enabled = 1 AND online_status = 1`, userID, id)
}

func (s *Store) Disconnect(ctx context.Context, userID int64, id string) error {
	_, err := s.update(ctx, `UPDATE user_device SET online_status = 0,
		last_disconnected_at = `+nowSQL+`, updated_at = `+nowSQL+`
		WHERE user_id = ? AND device_id = ? AND online_status = 1`, userID, id)
	return err
}

func (s *Store) Rename(ctx context.Context, userID int64, id, name string) (bool, error) {
	return s.update(ctx, `UPDATE user_device SET device_name = ?, updated_at = `+nowSQL+`
		WHERE user_id = ? AND device_id = ?`, name, userID, id)
}

func (s *Store) update(ctx context.Context, query string, args ...any) (bool, error) {
	r, err := s.db.ExecContext(ctx, query, args...)
	if err != nil {
		return false, err
	}
	n, err := r.RowsAffected()
	return n == 1, err
}

func (s *Store) List(ctx context.Context, userID int64) ([]Device, error) {
	rows, err := s.db.QueryContext(ctx, `SELECT device_id, device_name, enabled, online_status,
		last_connected_at, last_heartbeat_at, last_disconnected_at, terminal_connection_status,
		terminal_session_id, desktop_client_id, terminal_requested_at, terminal_connected_at,
		terminal_disconnected_at, terminal_error, created_at, updated_at
		FROM user_device WHERE user_id = ? ORDER BY updated_at DESC, id DESC`, userID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	devices := make([]Device, 0)
	for rows.Next() {
		var d Device
		if err := rows.Scan(&d.DeviceID, &d.DeviceName, &d.Enabled, &d.OnlineStatus,
			&d.LastConnectedAt, &d.LastHeartbeatAt, &d.LastDisconnectedAt, &d.TerminalConnectionStatus,
			&d.TerminalSessionID, &d.DesktopClientID, &d.TerminalRequestedAt, &d.TerminalConnectedAt,
			&d.TerminalDisconnectedAt, &d.TerminalError, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		devices = append(devices, d)
	}
	return devices, rows.Err()
}
