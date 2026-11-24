package httpapi

import (
	"context"
	"errors"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"web2term/backend/internal/store"
)

type FeedbackStore interface {
	CreateFeedback(context.Context, int64, store.FeedbackInput, int64) (store.Feedback, error)
	ListFeedback(context.Context, int64, int, int) ([]store.Feedback, int, error)
}

type feedbackAPI struct {
	store FeedbackStore
	now   func() time.Time
}

// WithFeedback mounts the signed-in feedback API on the shared listener and database.
func WithFeedback(database FeedbackStore) Option {
	return func(s *Server) { s.feedback = &feedbackAPI{store: database, now: time.Now} }
}

const (
	feedbackMaxRunes     = 5000
	feedbackMaxBodyBytes = 64 << 10
	feedbackEmailMax     = 254
	feedbackVersionMax   = 32
	feedbackPlatformMax  = 64
)

var (
	feedbackCategories   = map[string]bool{"bug": true, "feature": true, "improvement": true, "other": true}
	feedbackEmailPattern = regexp.MustCompile(`^[^\s@]+@[^\s@]+\.[^\s@]+$`)
)

func feedbackFailure(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]string{"code": code, "message": message})
}

// shortText accepts printable single-line metadata such as "0.1.242" or "win32-x64".
func shortText(raw string, maximum int) (string, bool) {
	value := strings.TrimSpace(raw)
	return value, utf8.ValidString(value) && utf8.RuneCountInString(value) <= maximum && strings.IndexFunc(value, unicode.IsControl) == -1
}

// feedbackContent keeps line breaks and tabs but rejects other control characters.
func feedbackContent(raw string) (string, bool) {
	value := strings.TrimSpace(strings.ReplaceAll(strings.ReplaceAll(raw, "\r\n", "\n"), "\r", "\n"))
	if value == "" || !utf8.ValidString(value) || utf8.RuneCountInString(value) > feedbackMaxRunes {
		return "", false
	}
	return value, strings.IndexFunc(value, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) == -1
}

func (s *Server) createFeedback(w http.ResponseWriter, r *http.Request) {
	userID, err := s.users.Introspect(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	if !s.limits.allow(r.RemoteAddr, "feedback", 30) {
		feedbackFailure(w, http.StatusTooManyRequests, "FEEDBACK_TOO_FREQUENT", "反馈提交过于频繁，请稍后再试")
		return
	}
	var payload struct {
		MachineID  string `json:"machineId"`
		Category   string `json:"category"`
		Content    string `json:"content"`
		Email      string `json:"email"`
		AppVersion string `json:"appVersion"`
		Platform   string `json:"platform"`
	}
	if !decodeLimited(w, r, &payload, feedbackMaxBodyBytes) {
		return
	}
	if !feedbackCategories[payload.Category] {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_FEEDBACK_CATEGORY", "反馈类型无效")
		return
	}
	content, ok := feedbackContent(payload.Content)
	if !ok {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_FEEDBACK_CONTENT", "反馈内容需为 1～5000 字的文本")
		return
	}
	email := strings.TrimSpace(payload.Email)
	if email != "" && (len(email) > feedbackEmailMax || !feedbackEmailPattern.MatchString(email)) {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_EMAIL", "邮箱格式不正确")
		return
	}
	machineID := ""
	if strings.TrimSpace(payload.MachineID) != "" {
		if machineID = normalizeUUID(payload.MachineID); machineID == "" {
			feedbackFailure(w, http.StatusBadRequest, "INVALID_MACHINE_ID", "本机标识无效")
			return
		}
	}
	appVersion, okVersion := shortText(payload.AppVersion, feedbackVersionMax)
	platform, okPlatform := shortText(payload.Platform, feedbackPlatformMax)
	if !okVersion || !okPlatform {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_CLIENT_INFO", "客户端信息无效")
		return
	}
	item, err := s.feedback.store.CreateFeedback(r.Context(), userID, store.FeedbackInput{
		MachineID: machineID, Category: payload.Category, Content: content, Email: email,
		AppVersion: appVersion, Platform: platform,
	}, s.feedback.now().UnixMilli())
	switch {
	case errors.Is(err, store.ErrFeedbackQuota):
		feedbackFailure(w, http.StatusTooManyRequests, "FEEDBACK_DAILY_LIMIT", "今天提交的反馈已达上限，请明天再试")
	case errors.Is(err, store.ErrUserDisabled):
		feedbackFailure(w, http.StatusForbidden, "USER_DISABLED", "账号已被禁用")
	case store.IsBusy(err):
		feedbackFailure(w, http.StatusServiceUnavailable, "FEEDBACK_BUSY", "服务繁忙，请稍后重试")
	case err != nil:
		s.log.Error("feedback create failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "反馈保存失败，请稍后重试")
	default:
		writeJSON(w, http.StatusCreated, item)
	}
}

func (s *Server) listFeedback(w http.ResponseWriter, r *http.Request) {
	userID, err := s.users.Introspect(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	limit, okLimit := queryInt(r, "limit", 20, 1, 100)
	offset, okOffset := queryInt(r, "offset", 0, 0, 1_000_000)
	if !okLimit || !okOffset {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_PAGINATION", "分页参数无效")
		return
	}
	items, total, err := s.feedback.store.ListFeedback(r.Context(), userID, limit, offset)
	if err != nil {
		s.log.Error("feedback list failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取反馈失败，请稍后重试")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total, "limit": limit, "offset": offset})
}

func queryInt(r *http.Request, name string, fallback, minimum, maximum int) (int, bool) {
	raw := r.URL.Query().Get(name)
	if raw == "" {
		return fallback, true
	}
	value, err := strconv.Atoi(raw)
	return value, err == nil && value >= minimum && value <= maximum
}
