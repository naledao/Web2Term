package store

import (
	"context"
	"database/sql"
	"strings"
	"time"
)

const dayMillis = 24 * 60 * 60 * 1000

// statsZone is the calendar used for "per day" figures (UTC+8, mainland China time).
var statsZone = time.FixedZone("UTC+8", 8*60*60)

type DailyCount struct {
	Date  string `json:"date"` // YYYY-MM-DD in UTC+8
	Count int    `json:"count"`
}

type NoteReach struct {
	ID          int64  `json:"id"`
	Version     string `json:"version"`
	Title       string `json:"title"`
	PublishedAt int64  `json:"publishedAt"`
	ReadCount   int    `json:"readCount"`
}

// AdminStats summarises the backend for the administration overview. Machine
// figures come only from release-note read records, so they count machines that
// have opened the release notes, not every installation.
type AdminStats struct {
	Users struct {
		Total    int `json:"total"`
		New7d    int `json:"new7d"`
		Active7d int `json:"active7d"`
		Disabled int `json:"disabled"`
		Admins   int `json:"admins"`
	} `json:"users"`
	Feedback struct {
		Pending    int `json:"pending"`
		InProgress int `json:"inProgress"`
		New7d      int `json:"new7d"`
		Total      int `json:"total"`
	} `json:"feedback"`
	ReleaseNotes struct {
		Published int `json:"published"`
		Scheduled int `json:"scheduled"`
		Drafts    int `json:"drafts"`
		Offline   int `json:"offline"`
	} `json:"releaseNotes"`
	Machines struct {
		Total     int          `json:"total"`
		Read7d    int          `json:"read7d"`
		Read30d   int          `json:"read30d"`
		DailyNew  []DailyCount `json:"dailyNew"`
		NoteReach []NoteReach  `json:"noteReach"`
	} `json:"machines"`
	OnlineDevices int `json:"onlineDevices"`
}

func statsDate(millis int64) string { return time.UnixMilli(millis).In(statsZone).Format("2006-01-02") }

func (s *Store) AdminStats(ctx context.Context, now int64) (AdminStats, error) {
	var stats AdminStats
	tx, err := s.db.BeginTx(ctx, &sql.TxOptions{ReadOnly: true})
	if err != nil {
		return stats, err
	}
	defer tx.Rollback()
	week := now - 7*dayMillis
	weekISO := time.UnixMilli(week).UTC().Format("2006-01-02T15:04:05.000Z")
	queries := []struct {
		query string
		args  []any
		dest  *int
	}{
		{"SELECT COUNT(*) FROM user_account", nil, &stats.Users.Total},
		{"SELECT COUNT(*) FROM user_account WHERE created_at >= ?", []any{weekISO}, &stats.Users.New7d},
		{"SELECT COUNT(*) FROM user_account WHERE last_login_at >= ?", []any{week}, &stats.Users.Active7d},
		{"SELECT COUNT(*) FROM user_account WHERE enabled = 0", nil, &stats.Users.Disabled},
		{"SELECT COUNT(*) FROM user_account WHERE role = 'ADMIN' AND enabled = 1", nil, &stats.Users.Admins},
		{"SELECT COUNT(*) FROM app_feedback WHERE status = 0", nil, &stats.Feedback.Pending},
		{"SELECT COUNT(*) FROM app_feedback WHERE status = 1", nil, &stats.Feedback.InProgress},
		{"SELECT COUNT(*) FROM app_feedback WHERE created_at >= ?", []any{week}, &stats.Feedback.New7d},
		{"SELECT COUNT(*) FROM app_feedback", nil, &stats.Feedback.Total},
		{"SELECT COUNT(*) FROM app_release_note WHERE status = 1 AND published_at <= ?", []any{now}, &stats.ReleaseNotes.Published},
		{"SELECT COUNT(*) FROM app_release_note WHERE status = 1 AND published_at > ?", []any{now}, &stats.ReleaseNotes.Scheduled},
		{"SELECT COUNT(*) FROM app_release_note WHERE status = 0", nil, &stats.ReleaseNotes.Drafts},
		{"SELECT COUNT(*) FROM app_release_note WHERE status = 2", nil, &stats.ReleaseNotes.Offline},
		{"SELECT COUNT(DISTINCT machine_id) FROM app_release_note_read", nil, &stats.Machines.Total},
		{"SELECT COUNT(*) FROM (SELECT machine_id FROM app_release_note_read GROUP BY machine_id HAVING MAX(read_at) >= ?)", []any{week}, &stats.Machines.Read7d},
		{"SELECT COUNT(*) FROM (SELECT machine_id FROM app_release_note_read GROUP BY machine_id HAVING MAX(read_at) >= ?)", []any{now - 30*dayMillis}, &stats.Machines.Read30d},
	}
	for _, q := range queries {
		if err := tx.QueryRowContext(ctx, q.query, q.args...).Scan(q.dest); err != nil {
			return stats, err
		}
	}

	// New machines per day for the last 30 calendar days (UTC+8), by first read.
	today := time.UnixMilli(now).In(statsZone)
	start := time.Date(today.Year(), today.Month(), today.Day(), 0, 0, 0, 0, statsZone).AddDate(0, 0, -29)
	counts := map[string]int{}
	rows, err := tx.QueryContext(ctx, "SELECT MIN(read_at) FROM app_release_note_read GROUP BY machine_id HAVING MIN(read_at) >= ?", start.UnixMilli())
	if err != nil {
		return stats, err
	}
	for rows.Next() {
		var first int64
		if err := rows.Scan(&first); err != nil {
			rows.Close()
			return stats, err
		}
		counts[statsDate(first)]++
	}
	if err := rows.Close(); err != nil {
		return stats, err
	}
	stats.Machines.DailyNew = make([]DailyCount, 0, 30)
	for day := 0; day < 30; day++ {
		date := start.AddDate(0, 0, day).Format("2006-01-02")
		stats.Machines.DailyNew = append(stats.Machines.DailyNew, DailyCount{Date: date, Count: counts[date]})
	}

	// Reach of the ten most recently published notes.
	rows, err = tx.QueryContext(ctx, `SELECT n.id, n.version, n.title, n.published_at,
		(SELECT COUNT(*) FROM app_release_note_read r WHERE r.release_note_id = n.id)
		FROM app_release_note n WHERE n.status = 1 AND n.published_at <= ? ORDER BY n.published_at DESC, n.id DESC LIMIT 10`, now)
	if err != nil {
		return stats, err
	}
	defer rows.Close()
	stats.Machines.NoteReach = []NoteReach{}
	for rows.Next() {
		var reach NoteReach
		if err := rows.Scan(&reach.ID, &reach.Version, &reach.Title, &reach.PublishedAt, &reach.ReadCount); err != nil {
			return stats, err
		}
		stats.Machines.NoteReach = append(stats.Machines.NoteReach, reach)
	}
	if err := rows.Err(); err != nil {
		return stats, err
	}
	return stats, tx.Commit()
}

// Machine is one machine ID seen in release-note read records.
type Machine struct {
	MachineID     string `json:"machineId"`
	FirstReadAt   int64  `json:"firstReadAt"`
	LastReadAt    int64  `json:"lastReadAt"`
	ReadCount     int    `json:"readCount"`
	FeedbackCount int    `json:"feedbackCount"`
}

// ListMachines lists machines by most recent read. Query matches part of the machine ID.
func (s *Store) ListMachines(ctx context.Context, query string, limit, offset int) ([]Machine, int, error) {
	where, args := "", []any{}
	if query != "" {
		where, args = ` WHERE machine_id LIKE ? ESCAPE '\'`, []any{likePattern(strings.ToLower(query))}
	}
	var total int
	if err := s.db.QueryRowContext(ctx, "SELECT COUNT(DISTINCT machine_id) FROM app_release_note_read"+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	rows, err := s.db.QueryContext(ctx, `SELECT r.machine_id, MIN(r.read_at), MAX(r.read_at), COUNT(*),
		(SELECT COUNT(*) FROM app_feedback f WHERE f.machine_id = r.machine_id)
		FROM app_release_note_read r`+strings.Replace(where, "machine_id", "r.machine_id", 1)+`
		GROUP BY r.machine_id ORDER BY MAX(r.read_at) DESC, r.machine_id LIMIT ? OFFSET ?`, append(args, limit, offset)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	machines := make([]Machine, 0, limit)
	for rows.Next() {
		var machine Machine
		if err := rows.Scan(&machine.MachineID, &machine.FirstReadAt, &machine.LastReadAt, &machine.ReadCount, &machine.FeedbackCount); err != nil {
			return nil, 0, err
		}
		machines = append(machines, machine)
	}
	return machines, total, rows.Err()
}
