package store

import (
	"context"
	"database/sql"
	"errors"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

type scanner interface{ Scan(...any) error }

func scanNote(row scanner) (Note, error) {
	var note Note
	var publishedAt sql.NullInt64
	err := row.Scan(&note.ID, &note.Version, &note.Title, &note.ContentHTML, &note.Status,
		&publishedAt, &note.CreatedAt, &note.UpdatedAt)
	if publishedAt.Valid {
		note.PublishedAt = &publishedAt.Int64
	}
	return note, mapError(err)
}

func scanSummary(row scanner, html *string) (Summary, error) {
	var summary Summary
	var readAt sql.NullInt64
	values := []any{&summary.ID, &summary.Version, &summary.Title, &summary.PublishedAt, &summary.IsRead, &readAt}
	if html != nil {
		values = append(values, html)
	}
	err := row.Scan(values...)
	if readAt.Valid {
		summary.ReadAt = &readAt.Int64
	}
	return summary, mapError(err)
}

func mapError(err error) error {
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	var sqliteError *sqlite.Error
	if errors.As(err, &sqliteError) && sqliteError.Code() == sqlite3.SQLITE_CONSTRAINT_UNIQUE {
		return ErrConflict
	}
	return err
}

// IsBusy allows the API to distinguish a retryable database lock from an internal error.
func IsBusy(err error) bool {
	var sqliteError *sqlite.Error
	return errors.As(err, &sqliteError) && (sqliteError.Code()&0xff == sqlite3.SQLITE_BUSY || sqliteError.Code()&0xff == sqlite3.SQLITE_LOCKED)
}

const noteColumns = "id, version, title, content_html, status, published_at, created_at, updated_at"

func (s *Store) CreateReleaseNote(ctx context.Context, input NoteInput, now int64) (Note, error) {
	input, err := normalize(input)
	if err != nil {
		return Note{}, err
	}
	if *input.Status == Published && input.PublishedAt == nil {
		input.PublishedAt = &now
	}
	return scanNote(s.db.QueryRowContext(ctx, `INSERT INTO app_release_note
		(version, title, content_html, status, published_at, created_at, updated_at)
		VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING `+noteColumns,
		input.Version, input.Title, input.ContentHTML, *input.Status, input.PublishedAt, now, now))
}

func (s *Store) UpdateReleaseNote(ctx context.Context, id int64, input NoteInput, now int64) (Note, error) {
	input, err := normalize(input)
	if err != nil {
		return Note{}, err
	}
	return scanNote(s.db.QueryRowContext(ctx, `UPDATE app_release_note SET
		version = ?, title = ?, content_html = ?, status = ?,
		published_at = CASE WHEN ? = 1 THEN COALESCE(?, published_at, ?) ELSE ? END,
		updated_at = ? WHERE id = ? RETURNING `+noteColumns,
		input.Version, input.Title, input.ContentHTML, *input.Status, *input.Status,
		input.PublishedAt, now, input.PublishedAt, now, id))
}

func (s *Store) GetAdminReleaseNote(ctx context.Context, id int64) (Note, error) {
	return scanNote(s.db.QueryRowContext(ctx, "SELECT "+noteColumns+" FROM app_release_note WHERE id = ?", id))
}

func (s *Store) DeleteReleaseNote(ctx context.Context, id int64) error {
	result, err := s.db.ExecContext(ctx, "DELETE FROM app_release_note WHERE id = ?", id)
	if err != nil {
		return err
	}
	count, err := result.RowsAffected()
	if err == nil && count == 0 {
		return ErrNotFound
	}
	return err
}

func (s *Store) ListAdminReleaseNotes(ctx context.Context, limit, offset int) (AdminPage, error) {
	page := AdminPage{Items: []Note{}, Limit: limit, Offset: offset}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, "SELECT COUNT(*) FROM app_release_note").Scan(&page.Total); err != nil {
		return page, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT id, version, title, '', status, published_at, created_at, updated_at
		FROM app_release_note ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`, limit, offset)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		note, err := scanNote(rows)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, note)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if err := rows.Close(); err != nil {
		return page, err
	}
	return page, tx.Commit()
}

func (s *Store) ListReleaseNotes(ctx context.Context, machineID string, now int64, limit, offset int) (Page, error) {
	page := Page{Items: []Summary{}, Limit: limit, Offset: offset}
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return page, err
	}
	defer tx.Rollback()
	if err := tx.QueryRowContext(ctx, `SELECT COUNT(*), COALESCE(SUM(CASE WHEN r.release_note_id IS NULL THEN 1 ELSE 0 END), 0)
		FROM app_release_note n LEFT JOIN app_release_note_read r ON r.release_note_id = n.id AND r.machine_id = ?
		WHERE n.status = 1 AND n.published_at <= ?`, machineID, now).Scan(&page.Total, &page.UnreadCount); err != nil {
		return page, err
	}
	rows, err := tx.QueryContext(ctx, `SELECT n.id, n.version, n.title, n.published_at,
		r.release_note_id IS NOT NULL, r.read_at
		FROM app_release_note n LEFT JOIN app_release_note_read r ON r.release_note_id = n.id AND r.machine_id = ?
		WHERE n.status = 1 AND n.published_at <= ?
		ORDER BY n.published_at DESC, n.id DESC LIMIT ? OFFSET ?`, machineID, now, limit, offset)
	if err != nil {
		return page, err
	}
	defer rows.Close()
	for rows.Next() {
		summary, err := scanSummary(rows, nil)
		if err != nil {
			return page, err
		}
		page.Items = append(page.Items, summary)
	}
	if err := rows.Err(); err != nil {
		return page, err
	}
	if err := rows.Close(); err != nil {
		return page, err
	}
	return page, tx.Commit()
}

func (s *Store) GetReleaseNote(ctx context.Context, id int64, machineID string, now int64) (Detail, error) {
	var detail Detail
	summary, err := scanSummary(s.db.QueryRowContext(ctx, `SELECT n.id, n.version, n.title, n.published_at,
		r.release_note_id IS NOT NULL, r.read_at, n.content_html
		FROM app_release_note n LEFT JOIN app_release_note_read r ON r.release_note_id = n.id AND r.machine_id = ?
		WHERE n.id = ? AND n.status = 1 AND n.published_at <= ?`, machineID, id, now), &detail.ContentHTML)
	detail.Summary = summary
	return detail, err
}

func (s *Store) MarkReleaseNoteRead(ctx context.Context, id int64, machineID string, now int64) (int64, error) {
	var readAt int64
	err := s.db.QueryRowContext(ctx, `INSERT INTO app_release_note_read (machine_id, release_note_id, read_at)
		SELECT ?, n.id, ? FROM app_release_note n WHERE n.id = ? AND n.status = 1 AND n.published_at <= ?
		ON CONFLICT (machine_id, release_note_id) DO UPDATE
		SET read_at = MAX(app_release_note_read.read_at, excluded.read_at) RETURNING read_at`, machineID, now, id, now).Scan(&readAt)
	return readAt, mapError(err)
}
