package httpapi

import (
	"context"
	"database/sql"
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/store"
)

// AdminStore is the account and feedback data the administration API needs.
type AdminStore interface {
	UserByID(context.Context, int64) (store.User, error)
	ListAdminFeedback(context.Context, store.AdminFeedbackFilter, int, int) ([]store.AdminFeedback, int, map[int]int, error)
	GetAdminFeedback(context.Context, int64) (store.AdminFeedback, error)
	UpdateAdminFeedback(context.Context, int64, store.AdminFeedbackUpdate, int64) (store.AdminFeedback, error)
	ListAdminUsers(context.Context, store.AdminUserFilter, int, int) ([]store.AdminUser, int, error)
	GetAdminUser(context.Context, string) (store.AdminUserDetail, error)
	UpdateAdminUser(context.Context, int64, string, store.AdminUserUpdate, int64) (store.AdminUser, error)
	RevokeUserSessions(context.Context, int64, string, int64) (store.AdminUser, error)
	AdminStats(context.Context, int64) (store.AdminStats, error)
	ListMachines(context.Context, string, int, int) ([]store.Machine, int, error)
}

type adminAPI struct {
	store AdminStore
	now   func() time.Time
}

// WithAdmin mounts GET /api/user/me and the role-based administration API.
// Administrators are ordinary login accounts with user_account.role = 'ADMIN'.
func WithAdmin(database AdminStore) Option {
	return func(s *Server) { s.admin = &adminAPI{store: database, now: time.Now} }
}

const (
	roleAdmin          = "ADMIN"
	adminNoteMaxRunes  = 2000
	adminQueryMaxRunes = 100
)

var errUnauthenticated = errors.New("not authenticated")

// lookupAccount resolves a bearer token to a live, enabled account. It returns
// errUnauthenticated for a missing, invalid or revoked login, the auth service's
// own failure when it is unavailable, or a database error.
func lookupAccount(ctx context.Context, users AuthService, byID func(context.Context, int64) (store.User, error), authorization string) (store.User, error) {
	userID, err := users.Introspect(ctx, authorization)
	if err != nil {
		if auth.FailureOf(err).Status == http.StatusUnauthorized {
			return store.User{}, errUnauthenticated
		}
		return store.User{}, err
	}
	user, err := byID(ctx, userID)
	if errors.Is(err, sql.ErrNoRows) {
		return store.User{}, errUnauthenticated
	}
	return user, err
}

// currentUser resolves the bearer token to a live, enabled account.
func (s *Server) currentUser(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	user, err := lookupAccount(r.Context(), s.users, s.admin.store.UserByID, r.Header.Get("Authorization"))
	switch {
	case errors.Is(err, errUnauthenticated):
		feedbackFailure(w, http.StatusUnauthorized, "UNAUTHORIZED", "当前请求尚未认证")
		return store.User{}, false
	case err != nil:
		var failure *auth.Failure
		if errors.As(err, &failure) {
			writeFailure(w, err)
		} else {
			s.log.Error("user lookup failed")
			feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用")
		}
		return store.User{}, false
	}
	return user, true
}

func (s *Server) requireAdmin(w http.ResponseWriter, r *http.Request) bool {
	_, ok := s.requireAdminUser(w, r)
	return ok
}

// requireAdminUser also returns the acting administrator, for audit records and self-protection.
func (s *Server) requireAdminUser(w http.ResponseWriter, r *http.Request) (store.User, bool) {
	user, ok := s.currentUser(w, r)
	if !ok {
		return store.User{}, false
	}
	if user.Role != roleAdmin {
		feedbackFailure(w, http.StatusForbidden, "ADMIN_REQUIRED", "需要管理员权限")
		return store.User{}, false
	}
	return user, true
}

func (s *Server) me(w http.ResponseWriter, r *http.Request) {
	if user, ok := s.currentUser(w, r); ok {
		writeJSON(w, http.StatusOK, user)
	}
}

func (s *Server) adminListFeedback(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	limit, okLimit := queryInt(r, "limit", 20, 1, 100)
	offset, okOffset := queryInt(r, "offset", 0, 0, 1_000_000)
	if !okLimit || !okOffset {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_PAGINATION", "分页参数无效")
		return
	}
	query := r.URL.Query()
	filter := store.AdminFeedbackFilter{Category: query.Get("category"), Query: strings.TrimSpace(query.Get("q"))}
	if filter.Category != "" && !feedbackCategories[filter.Category] {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_FEEDBACK_CATEGORY", "反馈类型无效")
		return
	}
	if raw := query.Get("status"); raw != "" {
		status, err := strconv.Atoi(raw)
		if err != nil || !validFeedbackStatus(status) {
			feedbackFailure(w, http.StatusBadRequest, "INVALID_FEEDBACK_STATUS", "反馈状态无效")
			return
		}
		filter.Status = &status
	}
	if !utf8.ValidString(filter.Query) || utf8.RuneCountInString(filter.Query) > adminQueryMaxRunes {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_QUERY", "搜索内容过长")
		return
	}
	items, total, counts, err := s.admin.store.ListAdminFeedback(r.Context(), filter, limit, offset)
	if err != nil {
		s.log.Error("admin feedback list failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取反馈失败，请稍后重试")
		return
	}
	statusCounts := make(map[string]int, len(counts))
	for status, count := range counts {
		statusCounts[strconv.Itoa(status)] = count
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": items, "total": total, "limit": limit, "offset": offset, "statusCounts": statusCounts})
}

func feedbackID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	raw := r.PathValue("id")
	id, err := strconv.ParseInt(raw, 10, 64)
	if err != nil || id <= 0 || raw != strconv.FormatInt(id, 10) {
		feedbackFailure(w, http.StatusNotFound, "FEEDBACK_NOT_FOUND", "反馈不存在")
		return 0, false
	}
	return id, true
}

func (s *Server) adminGetFeedback(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	id, ok := feedbackID(w, r)
	if !ok {
		return
	}
	item, err := s.admin.store.GetAdminFeedback(r.Context(), id)
	s.writeAdminFeedback(w, item, err, http.StatusOK)
}

func (s *Server) adminUpdateFeedback(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	id, ok := feedbackID(w, r)
	if !ok {
		return
	}
	var payload struct {
		Status    *int    `json:"status"`
		AdminNote *string `json:"adminNote"`
	}
	if !decode(w, r, &payload) {
		return
	}
	if payload.Status == nil && payload.AdminNote == nil {
		feedbackFailure(w, http.StatusBadRequest, "EMPTY_UPDATE", "没有需要保存的修改")
		return
	}
	if payload.Status != nil && !validFeedbackStatus(*payload.Status) {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_FEEDBACK_STATUS", "反馈状态无效")
		return
	}
	if payload.AdminNote != nil {
		note := strings.TrimSpace(strings.ReplaceAll(*payload.AdminNote, "\r\n", "\n"))
		if !utf8.ValidString(note) || utf8.RuneCountInString(note) > adminNoteMaxRunes ||
			strings.IndexFunc(note, func(r rune) bool { return unicode.IsControl(r) && r != '\n' && r != '\t' }) != -1 {
			feedbackFailure(w, http.StatusBadRequest, "INVALID_ADMIN_NOTE", "内部备注需为 2000 字以内的文本")
			return
		}
		payload.AdminNote = &note
	}
	item, err := s.admin.store.UpdateAdminFeedback(r.Context(), id,
		store.AdminFeedbackUpdate{Status: payload.Status, AdminNote: payload.AdminNote}, s.admin.now().UnixMilli())
	s.writeAdminFeedback(w, item, err, http.StatusOK)
}

func (s *Server) writeAdminFeedback(w http.ResponseWriter, item store.AdminFeedback, err error, status int) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		feedbackFailure(w, http.StatusNotFound, "FEEDBACK_NOT_FOUND", "反馈不存在")
	case store.IsBusy(err):
		feedbackFailure(w, http.StatusServiceUnavailable, "FEEDBACK_BUSY", "服务繁忙，请稍后重试")
	case err != nil:
		s.log.Error("admin feedback operation failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "操作失败，请稍后重试")
	default:
		writeJSON(w, status, item)
	}
}

func validFeedbackStatus(status int) bool {
	return status >= store.FeedbackPending && status <= store.FeedbackClosed
}
