package store

import (
	"context"
	"database/sql"
	"errors"
	"strings"
)

// FeedbackSubmitter is the account that submitted a feedback item. The
// internal numeric id is never exposed.
type FeedbackSubmitter struct {
	PublicID string `json:"publicId"`
	Email    string `json:"email"`
	Nickname string `json:"nickname"`
}

// AdminFeedback adds the internal fields that only administrators may see.
type AdminFeedback struct {
	Feedback
	MachineID *string           `json:"machineId"`
	AdminNote *string           `json:"adminNote"`
	User      FeedbackSubmitter `json:"user"`
}

type AdminFeedbackFilter struct {
	Status   *int
	Category string
	// Query matches content, contact email or the submitter's login email.
	Query string
}

// AdminFeedbackUpdate fields left nil are unchanged. An empty AdminNote clears it.
type AdminFeedbackUpdate struct {
	Status    *int
	AdminNote *string
}

const adminFeedbackColumns = `f.id, f.category, f.content, f.email, f.app_version, f.platform, f.status, f.created_at, f.updated_at,
	f.machine_id, f.admin_note, u.public_id, u.email, u.nickname`

const adminFeedbackFrom = " FROM app_feedback f JOIN user_account u ON u.id = f.user_id"

func scanAdminFeedback(row scanner) (AdminFeedback, error) {
	var item AdminFeedback
	err := row.Scan(&item.ID, &item.Category, &item.Content, &item.Email, &item.AppVersion, &item.Platform, &item.Status,
		&item.CreatedAt, &item.UpdatedAt, &item.MachineID, &item.AdminNote, &item.User.PublicID, &item.User.Email, &item.User.Nickname)
	if errors.Is(err, sql.ErrNoRows) {
		return item, ErrNotFound
	}
	return item, err
}

func likePattern(query string) string {
	escaped := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(query)
	return "%" + escaped + "%"
}

// ListAdminFeedback returns one page plus per-status counts. The counts honour
// the category and query filters but not the status filter, so the UI can show
// how many items each status tab would contain.
func (s *Store) ListAdminFeedback(ctx context.Context, filter AdminFeedbackFilter, limit, offset int) ([]AdminFeedback, int, map[int]int, error) {
	var where []string
	var args []any
	if filter.Category != "" {
		where = append(where, "f.category = ?")
		args = append(args, filter.Category)
	}
	if filter.Query != "" {
		pattern := likePattern(filter.Query)
		where = append(where, `(f.content LIKE ? ESCAPE '\' OR f.email LIKE ? ESCAPE '\' OR u.email LIKE ? ESCAPE '\')`)
		args = append(args, pattern, pattern, pattern)
	}
	base := adminFeedbackFrom
	if len(where) > 0 {
		base += " WHERE " + strings.Join(where, " AND ")
	}

	counts := map[int]int{FeedbackPending: 0, FeedbackInProgress: 0, FeedbackResolved: 0, FeedbackClosed: 0}
	rows, err := s.db.QueryContext(ctx, "SELECT f.status, COUNT(*)"+base+" GROUP BY f.status", args...)
	if err != nil {
		return nil, 0, nil, err
	}
	for rows.Next() {
		var status, count int
		if err := rows.Scan(&status, &count); err != nil {
			rows.Close()
			return nil, 0, nil, err
		}
		counts[status] = count
	}
	if err := rows.Close(); err != nil {
		return nil, 0, nil, err
	}

	listed := base
	listArgs := append([]any{}, args...)
	if filter.Status != nil {
		if len(where) > 0 {
			listed += " AND f.status = ?"
		} else {
			listed += " WHERE f.status = ?"
		}
		listArgs = append(listArgs, *filter.Status)
	}
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*)"+listed, listArgs...).Scan(&total); err != nil {
		return nil, 0, nil, err
	}
	rows, err = s.db.QueryContext(ctx, "SELECT "+adminFeedbackColumns+listed+" ORDER BY f.created_at DESC, f.id DESC LIMIT ? OFFSET ?",
		append(listArgs, limit, offset)...)
	if err != nil {
		return nil, 0, nil, err
	}
	defer rows.Close()
	items := make([]AdminFeedback, 0, limit)
	for rows.Next() {
		item, err := scanAdminFeedback(rows)
		if err != nil {
			return nil, 0, nil, err
		}
		items = append(items, item)
	}
	return items, total, counts, rows.Err()
}

func (s *Store) GetAdminFeedback(ctx context.Context, id int64) (AdminFeedback, error) {
	return scanAdminFeedback(s.db.QueryRowContext(ctx, "SELECT "+adminFeedbackColumns+adminFeedbackFrom+" WHERE f.id = ?", id))
}

func (s *Store) UpdateAdminFeedback(ctx context.Context, id int64, update AdminFeedbackUpdate, now int64) (AdminFeedback, error) {
	sets := []string{"updated_at = ?"}
	args := []any{now}
	if update.Status != nil {
		sets = append(sets, "status = ?")
		args = append(args, *update.Status)
	}
	if update.AdminNote != nil {
		sets = append(sets, "admin_note = NULLIF(?, '')")
		args = append(args, *update.AdminNote)
	}
	result, err := s.db.ExecContext(ctx, "UPDATE app_feedback SET "+strings.Join(sets, ", ")+" WHERE id = ?", append(args, id)...)
	if err != nil {
		return AdminFeedback{}, err
	}
	if changed, err := result.RowsAffected(); err != nil {
		return AdminFeedback{}, err
	} else if changed == 0 {
		return AdminFeedback{}, ErrNotFound
	}
	return s.GetAdminFeedback(ctx, id)
}
