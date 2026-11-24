package httpapi

import (
	"errors"
	"net/http"
	"regexp"
	"strings"
	"unicode/utf8"

	"web2term/backend/internal/store"
)

var publicIDPattern = regexp.MustCompile(`^[A-Za-z0-9_-]{1,64}$`)

func adminUserPublicID(w http.ResponseWriter, r *http.Request) (string, bool) {
	id := r.PathValue("publicId")
	if !publicIDPattern.MatchString(id) {
		feedbackFailure(w, http.StatusNotFound, "USER_NOT_FOUND", "用户不存在")
		return "", false
	}
	return id, true
}

func (s *Server) adminListUsers(w http.ResponseWriter, r *http.Request) {
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
	filter := store.AdminUserFilter{Query: strings.TrimSpace(query.Get("q")), Role: query.Get("role")}
	if !utf8.ValidString(filter.Query) || utf8.RuneCountInString(filter.Query) > adminQueryMaxRunes {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_QUERY", "搜索内容过长")
		return
	}
	if filter.Role != "" && filter.Role != store.RoleUser && filter.Role != store.RoleAdmin {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_ROLE", "角色无效")
		return
	}
	switch query.Get("enabled") {
	case "":
	case "1", "true":
		enabled := true
		filter.Enabled = &enabled
	case "0", "false":
		enabled := false
		filter.Enabled = &enabled
	default:
		feedbackFailure(w, http.StatusBadRequest, "INVALID_ENABLED", "状态筛选无效")
		return
	}
	users, total, err := s.admin.store.ListAdminUsers(r.Context(), filter, limit, offset)
	if err != nil {
		s.log.Error("admin user list failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取用户失败，请稍后重试")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": users, "total": total, "limit": limit, "offset": offset})
}

func (s *Server) adminGetUser(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	id, ok := adminUserPublicID(w, r)
	if !ok {
		return
	}
	detail, err := s.admin.store.GetAdminUser(r.Context(), id)
	if err != nil {
		s.adminUserFailure(w, err)
		return
	}
	// Presence comes from live connections; the stored flag is reset on restart.
	writeJSON(w, http.StatusOK, map[string]any{"user": detail, "onlineDeviceIds": s.onlineDevices(detail.Devices)})
}

func (s *Server) onlineDevices(devices []store.AdminUserDevice) []string {
	online := []string{}
	for _, device := range devices {
		if s.hub.online(device.DeviceID) {
			online = append(online, device.DeviceID)
		}
	}
	return online
}

func (s *Server) adminUpdateUser(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireAdminUser(w, r)
	if !ok {
		return
	}
	id, ok := adminUserPublicID(w, r)
	if !ok {
		return
	}
	var payload struct {
		Enabled *bool   `json:"enabled"`
		Role    *string `json:"role"`
	}
	if !decode(w, r, &payload) {
		return
	}
	if payload.Enabled == nil && payload.Role == nil {
		feedbackFailure(w, http.StatusBadRequest, "EMPTY_UPDATE", "没有需要保存的修改")
		return
	}
	if payload.Role != nil && *payload.Role != store.RoleUser && *payload.Role != store.RoleAdmin {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_ROLE", "角色无效")
		return
	}
	user, err := s.admin.store.UpdateAdminUser(r.Context(), actor.ID, id,
		store.AdminUserUpdate{Enabled: payload.Enabled, Role: payload.Role}, s.admin.now().UnixMilli())
	if err != nil {
		s.adminUserFailure(w, err)
		return
	}
	if !user.Enabled {
		s.hub.disconnectUser(user.ID)
	}
	writeJSON(w, http.StatusOK, user)
}

func (s *Server) adminRevokeUserSessions(w http.ResponseWriter, r *http.Request) {
	actor, ok := s.requireAdminUser(w, r)
	if !ok {
		return
	}
	id, ok := adminUserPublicID(w, r)
	if !ok {
		return
	}
	user, err := s.admin.store.RevokeUserSessions(r.Context(), actor.ID, id, s.admin.now().UnixMilli())
	if err != nil {
		s.adminUserFailure(w, err)
		return
	}
	disconnected := s.hub.disconnectUser(user.ID)
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "disconnectedConnections": disconnected, "self": user.ID == actor.ID})
}

func (s *Server) adminUserFailure(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, store.ErrNotFound):
		feedbackFailure(w, http.StatusNotFound, "USER_NOT_FOUND", "用户不存在")
	case errors.Is(err, store.ErrSelfChange):
		feedbackFailure(w, http.StatusConflict, "SELF_CHANGE_FORBIDDEN", "不能禁用自己或取消自己的管理员身份")
	case errors.Is(err, store.ErrLastAdmin):
		feedbackFailure(w, http.StatusConflict, "LAST_ADMIN", "至少需要保留一个启用中的管理员")
	case store.IsBusy(err):
		feedbackFailure(w, http.StatusServiceUnavailable, "DATABASE_BUSY", "服务繁忙，请稍后重试")
	default:
		s.log.Error("admin user operation failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "操作失败，请稍后重试")
	}
}

func (s *Server) adminStats(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	stats, err := s.admin.store.AdminStats(r.Context(), s.admin.now().UnixMilli())
	if err != nil {
		s.log.Error("admin stats failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取统计失败，请稍后重试")
		return
	}
	stats.OnlineDevices = s.hub.onlineCount()
	writeJSON(w, http.StatusOK, stats)
}

func (s *Server) adminListMachines(w http.ResponseWriter, r *http.Request) {
	if !s.requireAdmin(w, r) {
		return
	}
	limit, okLimit := queryInt(r, "limit", 20, 1, 100)
	offset, okOffset := queryInt(r, "offset", 0, 0, 1_000_000)
	if !okLimit || !okOffset {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_PAGINATION", "分页参数无效")
		return
	}
	query := strings.TrimSpace(r.URL.Query().Get("q"))
	if len(query) > 36 || strings.IndexFunc(query, func(r rune) bool {
		return !(r == '-' || r >= '0' && r <= '9' || r >= 'a' && r <= 'f' || r >= 'A' && r <= 'F')
	}) != -1 {
		feedbackFailure(w, http.StatusBadRequest, "INVALID_QUERY", "机器 ID 只能包含十六进制字符和连字符")
		return
	}
	machines, total, err := s.admin.store.ListMachines(r.Context(), query, limit, offset)
	if err != nil {
		s.log.Error("admin machine list failed")
		feedbackFailure(w, http.StatusInternalServerError, "INTERNAL_ERROR", "读取机器失败，请稍后重试")
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"items": machines, "total": total, "limit": limit, "offset": offset})
}
