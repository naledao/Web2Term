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
	"time"

	"modernc.org/sqlite"
	sqlite3 "modernc.org/sqlite/lib"
)

//go:embed migrations/001_initial.sql
var initialSchema string

type Store struct{ db *sql.DB }

// Open opens only a local file. Connection pragmas apply even if a connection is replaced.
func Open(ctx context.Context, path string) (*Store, error) {
	if strings.TrimSpace(path) == "" {
		return nil, errors.New("database path is empty")
	}
	absolute, err := filepath.Abs(path)
	if err != nil {
		return nil, fmt.Errorf("resolve database path: %w", err)
	}
	if err := os.MkdirAll(filepath.Dir(absolute), 0o700); err != nil {
		return nil, fmt.Errorf("create database directory: %w", err)
	}
	uriPath := filepath.ToSlash(absolute)
	if !strings.HasPrefix(uriPath, "/") {
		uriPath = "/" + uriPath
	}
	params := url.Values{}
	params.Add("_pragma", "foreign_keys(1)")
	params.Add("_pragma", "busy_timeout(5000)")
	params.Add("_pragma", "journal_mode(WAL)")
	dsn := (&url.URL{Scheme: "file", Path: uriPath, RawQuery: params.Encode()}).String()
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	store := &Store{db: db}
	initCtx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if err := store.migrate(initCtx); err != nil {
		_ = db.Close()
		return nil, err
	}
	return store, nil
}

func (s *Store) Close() error                   { return s.db.Close() }
func (s *Store) Ping(ctx context.Context) error { return s.db.PingContext(ctx) }

func (s *Store) migrate(ctx context.Context) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin migration: %w", err)
	}
	defer tx.Rollback()
	var version int
	if err := tx.QueryRowContext(ctx, "PRAGMA user_version").Scan(&version); err != nil {
		return fmt.Errorf("read schema version: %w", err)
	}
	if version > 1 {
		return fmt.Errorf("database schema %d is newer than supported schema 1", version)
	}
	if version == 0 {
		if _, err := tx.ExecContext(ctx, initialSchema); err != nil {
			return fmt.Errorf("apply schema 1: %w", err)
		}
		if _, err := tx.ExecContext(ctx, "PRAGMA user_version = 1"); err != nil {
			return fmt.Errorf("record schema version: %w", err)
		}
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit migration: %w", err)
	}
	return nil
}

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

func (s *Store) Create(ctx context.Context, input NoteInput, now int64) (Note, error) {
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

func (s *Store) Update(ctx context.Context, id int64, input NoteInput, now int64) (Note, error) {
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

func (s *Store) GetAdmin(ctx context.Context, id int64) (Note, error) {
	return scanNote(s.db.QueryRowContext(ctx, "SELECT "+noteColumns+" FROM app_release_note WHERE id = ?", id))
}

func (s *Store) Delete(ctx context.Context, id int64) error {
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

func (s *Store) ListAdmin(ctx context.Context, limit, offset int) (AdminPage, error) {
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

func (s *Store) List(ctx context.Context, machineID string, now int64, limit, offset int) (Page, error) {
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

func (s *Store) Get(ctx context.Context, id int64, machineID string, now int64) (Detail, error) {
	var detail Detail
	summary, err := scanSummary(s.db.QueryRowContext(ctx, `SELECT n.id, n.version, n.title, n.published_at,
		r.release_note_id IS NOT NULL, r.read_at, n.content_html
		FROM app_release_note n LEFT JOIN app_release_note_read r ON r.release_note_id = n.id AND r.machine_id = ?
		WHERE n.id = ? AND n.status = 1 AND n.published_at <= ?`, machineID, id, now), &detail.ContentHTML)
	detail.Summary = summary
	return detail, err
}

func (s *Store) MarkRead(ctx context.Context, id int64, machineID string, now int64) (int64, error) {
	var readAt int64
	err := s.db.QueryRowContext(ctx, `INSERT INTO app_release_note_read (machine_id, release_note_id, read_at)
		SELECT ?, n.id, ? FROM app_release_note n WHERE n.id = ? AND n.status = 1 AND n.published_at <= ?
		ON CONFLICT (machine_id, release_note_id) DO UPDATE
		SET read_at = MAX(app_release_note_read.read_at, excluded.read_at) RETURNING read_at`, machineID, now, id, now).Scan(&readAt)
	return readAt, mapError(err)
}
