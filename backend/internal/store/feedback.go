package store

import (
	"context"
	"database/sql"
	"errors"
)

// ErrFeedbackQuota means the user reached FeedbackDailyLimit in the last 24 hours.
var ErrFeedbackQuota = errors.New("feedback quota exceeded")

const (
	FeedbackDailyLimit = 20
	feedbackDayMillis  = 24 * 60 * 60 * 1000
)

// Feedback status values; admin_note is internal and never part of this struct.
const (
	FeedbackPending    = 0
	FeedbackInProgress = 1
	FeedbackResolved   = 2
	FeedbackClosed     = 3
)

type Feedback struct {
	ID         int64  `json:"id"`
	Category   string `json:"category"`
	Content    string `json:"content"`
	Email      string `json:"email"`
	AppVersion string `json:"appVersion"`
	Platform   string `json:"platform"`
	Status     int    `json:"status"`
	CreatedAt  int64  `json:"createdAt"`
	UpdatedAt  int64  `json:"updatedAt"`
}

// FeedbackInput is validated by the HTTP layer. An empty Email falls back to
// the account's login email; an empty MachineID is stored as NULL.
type FeedbackInput struct {
	MachineID  string
	Category   string
	Content    string
	Email      string
	AppVersion string
	Platform   string
}

const feedbackColumns = "id, category, content, email, app_version, platform, status, created_at, updated_at"

func scanFeedback(row scanner) (Feedback, error) {
	var item Feedback
	err := row.Scan(&item.ID, &item.Category, &item.Content, &item.Email, &item.AppVersion, &item.Platform,
		&item.Status, &item.CreatedAt, &item.UpdatedAt)
	return item, err
}

// CreateFeedback checks the daily quota and inserts in one transaction, so
// concurrent submissions cannot both slip under the limit.
func (s *Store) CreateFeedback(ctx context.Context, userID int64, input FeedbackInput, now int64) (Feedback, error) {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return Feedback{}, err
	}
	defer tx.Rollback()
	var recent int
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM app_feedback WHERE user_id = ? AND created_at > ?",
		userID, now-feedbackDayMillis).Scan(&recent); err != nil {
		return Feedback{}, err
	}
	if recent >= FeedbackDailyLimit {
		return Feedback{}, ErrFeedbackQuota
	}
	var machine any
	if input.MachineID != "" {
		machine = input.MachineID
	}
	row := tx.QueryRowContext(ctx, `INSERT INTO app_feedback
		(user_id, machine_id, category, content, email, app_version, platform, created_at, updated_at)
		SELECT id, ?, ?, ?, COALESCE(NULLIF(?, ''), email), ?, ?, ?, ? FROM user_account WHERE id = ? AND enabled = 1
		RETURNING `+feedbackColumns,
		machine, input.Category, input.Content, input.Email, input.AppVersion, input.Platform, now, now, userID)
	item, err := scanFeedback(row)
	if errors.Is(err, sql.ErrNoRows) {
		return Feedback{}, ErrUserDisabled
	}
	if err != nil {
		return Feedback{}, err
	}
	if err := tx.Commit(); err != nil {
		return Feedback{}, err
	}
	return item, nil
}

// ListFeedback returns only the caller's own feedback, newest first.
func (s *Store) ListFeedback(ctx context.Context, userID int64, limit, offset int) ([]Feedback, int, error) {
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(*) FROM app_feedback WHERE user_id = ?", userID).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, "SELECT "+feedbackColumns+` FROM app_feedback WHERE user_id = ?
		ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, userID, limit, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	items := make([]Feedback, 0, limit)
	for rows.Next() {
		item, err := scanFeedback(rows)
		if err != nil {
			return nil, 0, err
		}
		items = append(items, item)
	}
	return items, total, rows.Err()
}
