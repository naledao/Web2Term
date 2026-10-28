package store

import (
	"errors"
	"regexp"
	"strings"
	"unicode/utf8"
)

const (
	Draft = iota
	Published
	Offline
)

const MaxHTMLBytes = 1024 * 1024

var (
	ErrNotFound    = errors.New("release note not found")
	ErrConflict    = errors.New("version already exists")
	versionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$`)
)

type ValidationError struct{ Message string }

func (e *ValidationError) Error() string { return e.Message }

// NoteInput describes a full replacement, not a partial patch.
type NoteInput struct {
	Version     string `json:"version"`
	Title       string `json:"title"`
	ContentHTML string `json:"contentHtml"`
	Status      *int   `json:"status"`
	PublishedAt *int64 `json:"publishedAt"`
}

func normalize(input NoteInput) (NoteInput, error) {
	input.Version = strings.TrimPrefix(strings.TrimSpace(input.Version), "v")
	input.Title = strings.TrimSpace(input.Title)
	invalid := func(message string) (NoteInput, error) { return NoteInput{}, &ValidationError{message} }
	if len(input.Version) > 32 || !versionPattern.MatchString(input.Version) {
		return invalid("version 必须是长度不超过 32 的版本号，例如 0.1.189。")
	}
	if utf8.RuneCountInString(input.Title) < 1 || utf8.RuneCountInString(input.Title) > 200 {
		return invalid("title 必须包含 1 到 200 个字符。")
	}
	if len(input.ContentHTML) > MaxHTMLBytes {
		return invalid("HTML 正文不能超过 1 MiB。")
	}
	if input.Status == nil || *input.Status < Draft || *input.Status > Offline {
		return invalid("status 必须明确指定为 0（草稿）、1（已发布）或 2（已下线）。")
	}
	if *input.Status == Published && strings.TrimSpace(input.ContentHTML) == "" {
		return invalid("发布时 HTML 正文不能为空。")
	}
	if input.PublishedAt != nil && *input.PublishedAt < 0 {
		return invalid("publishedAt 必须是非负的 Unix 毫秒时间戳。")
	}
	return input, nil
}

type Note struct {
	ID          int64  `json:"id"`
	Version     string `json:"version"`
	Title       string `json:"title"`
	ContentHTML string `json:"contentHtml,omitempty"`
	Status      int    `json:"status"`
	PublishedAt *int64 `json:"publishedAt"`
	CreatedAt   int64  `json:"createdAt"`
	UpdatedAt   int64  `json:"updatedAt"`
}

type Summary struct {
	ID          int64  `json:"id"`
	Version     string `json:"version"`
	Title       string `json:"title"`
	PublishedAt int64  `json:"publishedAt"`
	IsRead      bool   `json:"isRead"`
	ReadAt      *int64 `json:"readAt"`
}

type Detail struct {
	Summary
	ContentHTML string `json:"contentHtml"`
}

type Page struct {
	Items       []Summary `json:"items"`
	Total       int       `json:"total"`
	UnreadCount int       `json:"unreadCount"`
	Limit       int       `json:"limit"`
	Offset      int       `json:"offset"`
}

type AdminPage struct {
	Items  []Note `json:"items"`
	Total  int    `json:"total"`
	Limit  int    `json:"limit"`
	Offset int    `json:"offset"`
}
