package store

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var (
	ErrSelfChange = errors.New("administrators cannot disable or demote themselves")
	ErrLastAdmin  = errors.New("the last enabled administrator cannot be disabled or demoted")
)

const (
	RoleUser  = "USER"
	RoleAdmin = "ADMIN"
)

// AdminUser is an account as administrators see it. The internal id is only
// used inside the process (for audit and WebSocket disconnects) and never serialised.
type AdminUser struct {
	ID            int64   `json:"-"`
	PublicID      string  `json:"publicId"`
	Email         string  `json:"email"`
	Nickname      string  `json:"nickname"`
	Role          string  `json:"role"`
	Enabled       bool    `json:"enabled"`
	CreatedAt     int64   `json:"createdAt"`
	UpdatedAt     int64   `json:"updatedAt"`
	LastLoginAt   *int64  `json:"lastLoginAt"`
	DeviceCount   int     `json:"deviceCount"`
	FeedbackCount int     `json:"feedbackCount"`
	AvatarURL     *string `json:"avatarUrl"`
}

type AdminUserDevice struct {
	DeviceID           string `json:"deviceId"`
	DeviceName         string `json:"deviceName"`
	Enabled            bool   `json:"enabled"`
	LastConnectedAt    *int64 `json:"lastConnectedAt"`
	LastDisconnectedAt *int64 `json:"lastDisconnectedAt"`
}

type AuditEntry struct {
	ID         int64           `json:"id"`
	Action     string          `json:"action"`
	Detail     json.RawMessage `json:"detail"`
	ActorEmail string          `json:"actorEmail"`
	CreatedAt  int64           `json:"createdAt"`
}

type AdminUserDetail struct {
	AdminUser
	Devices        []AdminUserDevice `json:"devices"`
	RecentFeedback []Feedback        `json:"recentFeedback"`
	Audit          []AuditEntry      `json:"audit"`
}

type AdminUserFilter struct {
	Query   string
	Role    string
	Enabled *bool
}

type AdminUserUpdate struct {
	Enabled *bool
	Role    *string
}

// isoMillis converts the ISO-8601 text timestamps of user_account and user_device to Unix milliseconds.
func isoMillis(value string) int64 {
	for _, layout := range []string{"2006-01-02T15:04:05.999Z07:00", time.RFC3339Nano, "2006-01-02 15:04:05"} {
		if parsed, err := time.Parse(layout, value); err == nil {
			return parsed.UnixMilli()
		}
	}
	return 0
}

func optionalISOMillis(value sql.NullString) *int64 {
	if !value.Valid || value.String == "" {
		return nil
	}
	millis := isoMillis(value.String)
	if millis == 0 {
		return nil
	}
	return &millis
}

const adminUserColumns = `u.id, u.public_id, u.email, u.nickname, u.role, u.enabled, u.created_at, u.updated_at, u.last_login_at, u.avatar_url,
	(SELECT COUNT(*) FROM user_device d WHERE d.user_id = u.id),
	(SELECT COUNT(*) FROM app_feedback f WHERE f.user_id = u.id)`

func scanAdminUser(row scanner) (AdminUser, error) {
	var user AdminUser
	var created, updated string
	var lastLogin sql.NullInt64
	err := row.Scan(&user.ID, &user.PublicID, &user.Email, &user.Nickname, &user.Role, &user.Enabled, &created, &updated,
		&lastLogin, &user.AvatarURL, &user.DeviceCount, &user.FeedbackCount)
	if errors.Is(err, sql.ErrNoRows) {
		return user, ErrNotFound
	}
	if err != nil {
		return user, err
	}
	user.CreatedAt, user.UpdatedAt = isoMillis(created), isoMillis(updated)
	if lastLogin.Valid {
		user.LastLoginAt = &lastLogin.Int64
	}
	return user, nil
}

// ListAdminUsers returns accounts newest first. Query matches email or nickname.
func (s *Store) ListAdminUsers(ctx context.Context, filter AdminUserFilter, limit, offset int) ([]AdminUser, int, error) {
	var where []string
	var args []any
	if filter.Query != "" {
		pattern := likePattern(filter.Query)
		where = append(where, `(u.email LIKE ? ESCAPE '\' OR u.nickname LIKE ? ESCAPE '\' OR u.public_id = ?)`)
		args = append(args, pattern, pattern, filter.Query)
	}
	if filter.Role != "" {
		where = append(where, "u.role = ?")
		args = append(args, filter.Role)
	}
	if filter.Enabled != nil {
		where = append(where, "u.enabled = ?")
		args = append(args, *filter.Enabled)
	}
	clause := ""
	if len(where) > 0 {
		clause = " WHERE " + strings.Join(where, " AND ")
	}
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM user_account u"+clause, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+adminUserColumns+" FROM user_account u"+clause+" ORDER BY u.id DESC LIMIT ? OFFSET ?",
		append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	users := make([]AdminUser, 0, limit)
	for rows.Next() {
		user, err := scanAdminUser(rows)
		if err != nil {
			return nil, 0, err
		}
		users = append(users, user)
	}
	return users, total, rows.Err()
}

func (s *Store) adminUserByPublicID(ctx context.Context, q interface {
	QueryRowContext(context.Context, string, ...any) *sql.Row
}, publicID string) (AdminUser, error) {
	return scanAdminUser(q.QueryRowContext(ctx, "SELECT "+adminUserColumns+" FROM user_account u WHERE u.public_id = ?", publicID))
}

func (s *Store) GetAdminUser(ctx context.Context, publicID string) (AdminUserDetail, error) {
	user, err := s.adminUserByPublicID(ctx, s.db, publicID)
	if err != nil {
		return AdminUserDetail{}, err
	}
	detail := AdminUserDetail{AdminUser: user, Devices: []AdminUserDevice{}, RecentFeedback: []Feedback{}, Audit: []AuditEntry{}}

	rows, err := s.db.QueryContext(ctx, `SELECT device_id, device_name, enabled, last_connected_at, last_disconnected_at
		FROM user_device WHERE user_id = ? ORDER BY COALESCE(last_connected_at, created_at) DESC LIMIT 100`, user.ID)
	if err != nil {
		return AdminUserDetail{}, err
	}
	for rows.Next() {
		var device AdminUserDevice
		var connected, disconnected sql.NullString
		if err := rows.Scan(&device.DeviceID, &device.DeviceName, &device.Enabled, &connected, &disconnected); err != nil {
			rows.Close()
			return AdminUserDetail{}, err
		}
		device.LastConnectedAt, device.LastDisconnectedAt = optionalISOMillis(connected), optionalISOMillis(disconnected)
		detail.Devices = append(detail.Devices, device)
	}
	if err := rows.Close(); err != nil {
		return AdminUserDetail{}, err
	}

	if detail.RecentFeedback, _, err = s.ListFeedback(ctx, user.ID, 5, 0); err != nil {
		return AdminUserDetail{}, err
	}

	rows, err = s.db.QueryContext(ctx, `SELECT a.id, a.action, a.detail, COALESCE(u.email, ''), a.created_at
		FROM admin_audit_log a LEFT JOIN user_account u ON u.id = a.actor_user_id
		WHERE a.target_user_id = ? ORDER BY a.created_at DESC, a.id DESC LIMIT 20`, user.ID)
	if err != nil {
		return AdminUserDetail{}, err
	}
	defer rows.Close()
	for rows.Next() {
		var entry AuditEntry
		var raw string
		if err := rows.Scan(&entry.ID, &entry.Action, &raw, &entry.ActorEmail, &entry.CreatedAt); err != nil {
			return AdminUserDetail{}, err
		}
		entry.Detail = json.RawMessage(raw)
		detail.Audit = append(detail.Audit, entry)
	}
	return detail, rows.Err()
}

func audit(ctx context.Context, tx *sql.Tx, actorID int64, targetID int64, action string, detail map[string]any, now int64) error {
	raw, err := json.Marshal(detail)
	if err != nil {
		return err
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO admin_audit_log (actor_user_id, target_user_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)",
		actorID, targetID, action, string(raw), now)
	return err
}

// UpdateAdminUser changes enabled and/or role. Disabling an account also bumps
// token_version so its existing logins stop working everywhere. The last
// enabled administrator is protected, and so is the acting administrator.
func (s *Store) UpdateAdminUser(ctx context.Context, actorID int64, publicID string, update AdminUserUpdate, now int64) (AdminUser, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminUser{}, err
	}
	defer tx.Rollback()
	before, err := s.adminUserByPublicID(ctx, tx, publicID)
	if err != nil {
		return AdminUser{}, err
	}
	enabled, role := before.Enabled, before.Role
	if update.Enabled != nil {
		enabled = *update.Enabled
	}
	if update.Role != nil {
		role = *update.Role
	}
	if enabled == before.Enabled && role == before.Role {
		return before, nil
	}
	losesAdmin := before.Role == RoleAdmin && before.Enabled && (role != RoleAdmin || !enabled)
	if losesAdmin {
		if before.ID == actorID {
			return AdminUser{}, ErrSelfChange
		}
		var admins int
		if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM user_account WHERE role = 'ADMIN' AND enabled = 1").Scan(&admins); err != nil {
			return AdminUser{}, err
		}
		if admins <= 1 {
			return AdminUser{}, ErrLastAdmin
		}
	}
	if before.ID == actorID && !enabled {
		return AdminUser{}, ErrSelfChange
	}
	bump := 0
	if before.Enabled && !enabled {
		bump = 1
	}
	if _, err := tx.ExecContext(ctx, `UPDATE user_account SET enabled = ?, role = ?, token_version = token_version + ?, updated_at = `+nowSQL+` WHERE id = ?`,
		enabled, role, bump, before.ID); err != nil {
		return AdminUser{}, err
	}
	changes := map[string]any{}
	if enabled != before.Enabled {
		changes["enabled"] = map[string]bool{"from": before.Enabled, "to": enabled}
	}
	if role != before.Role {
		changes["role"] = map[string]string{"from": before.Role, "to": role}
	}
	if err := audit(ctx, tx, actorID, before.ID, "user.update", changes, now); err != nil {
		return AdminUser{}, err
	}
	after, err := s.adminUserByPublicID(ctx, tx, publicID)
	if err != nil {
		return AdminUser{}, err
	}
	return after, tx.Commit()
}

// RevokeUserSessions invalidates every login token of the account.
func (s *Store) RevokeUserSessions(ctx context.Context, actorID int64, publicID string, now int64) (AdminUser, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return AdminUser{}, err
	}
	defer tx.Rollback()
	user, err := s.adminUserByPublicID(ctx, tx, publicID)
	if err != nil {
		return AdminUser{}, err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE user_account SET token_version = token_version + 1, updated_at = "+nowSQL+" WHERE id = ?", user.ID); err != nil {
		return AdminUser{}, err
	}
	if err := audit(ctx, tx, actorID, user.ID, "user.revoke_sessions", map[string]any{}, now); err != nil {
		return AdminUser{}, err
	}
	after, err := s.adminUserByPublicID(ctx, tx, publicID)
	if err != nil {
		return AdminUser{}, err
	}
	return after, tx.Commit()
}
