package httpapi

import (
	"context"
	"crypto/sha256"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"web2term/release-notes/internal/store"
)

type API struct {
	store        *store.Store
	logger       *slog.Logger
	adminHash    [32]byte
	adminEnabled bool
	now          func() time.Time
}

func New(database *store.Store, adminToken string, logger *slog.Logger) http.Handler {
	if logger == nil {
		logger = slog.Default()
	}
	api := &API{store: database, logger: logger, adminHash: sha256.Sum256([]byte(adminToken)),
		adminEnabled: adminToken != "", now: time.Now}
	return api.handler()
}

func (a *API) handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", a.health)
	mux.HandleFunc("GET /api/v1/release-notes", a.list)
	mux.HandleFunc("GET /api/v1/release-notes/{id}", a.detail)
	mux.HandleFunc("POST /api/v1/release-notes/{id}/read", a.markRead)
	mux.HandleFunc("GET /api/v1/admin/release-notes", a.admin(a.adminList))
	mux.HandleFunc("POST /api/v1/admin/release-notes", a.admin(a.adminCreate))
	mux.HandleFunc("GET /api/v1/admin/release-notes/{id}", a.admin(a.adminDetail))
	mux.HandleFunc("PUT /api/v1/admin/release-notes/{id}", a.admin(a.adminUpdate))
	mux.HandleFunc("DELETE /api/v1/admin/release-notes/{id}", a.admin(a.adminDelete))
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("X-Content-Type-Options", "nosniff")
		ctx, cancel := context.WithTimeout(r.Context(), 15*time.Second)
		defer cancel()
		defer func() {
			if recovered := recover(); recovered != nil {
				a.logger.Error("request panic", "method", r.Method, "path", r.URL.Path, "panic", recovered)
				writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。")
			}
		}()
		mux.ServeHTTP(w, r.WithContext(ctx))
	})
}

func (a *API) admin(next http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if !a.adminEnabled {
			writeError(w, http.StatusServiceUnavailable, "ADMIN_DISABLED", "管理接口尚未启用。")
			return
		}
		authorization := r.Header.Get("Authorization")
		scheme, token, found := strings.Cut(authorization, " ")
		digest := sha256.Sum256([]byte(token))
		if !found || !strings.EqualFold(scheme, "Bearer") || subtle.ConstantTimeCompare(digest[:], a.adminHash[:]) != 1 {
			w.Header().Set("WWW-Authenticate", "Bearer")
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "管理令牌无效。")
			return
		}
		next(w, r)
	}
}

func writeJSON(w http.ResponseWriter, status int, data any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(data)
}

func writeError(w http.ResponseWriter, status int, code, message string) {
	writeJSON(w, status, map[string]any{"error": map[string]string{"code": code, "message": message}})
}

func (a *API) failure(w http.ResponseWriter, r *http.Request, err error) {
	var validation *store.ValidationError
	switch {
	case errors.As(err, &validation):
		writeError(w, http.StatusBadRequest, "INVALID_REQUEST", validation.Message)
	case errors.Is(err, store.ErrNotFound):
		writeError(w, http.StatusNotFound, "NOT_FOUND", "更新说明不存在或暂不可查看。")
	case errors.Is(err, store.ErrConflict):
		writeError(w, http.StatusConflict, "VERSION_EXISTS", "该版本的更新说明已存在。")
	case store.IsBusy(err):
		w.Header().Set("Retry-After", "1")
		writeError(w, http.StatusServiceUnavailable, "DATABASE_BUSY", "数据库繁忙，请稍后重试。")
	case errors.Is(err, context.DeadlineExceeded):
		writeError(w, http.StatusGatewayTimeout, "REQUEST_TIMEOUT", "请求超时，请稍后重试。")
	case errors.Is(err, context.Canceled):
		return
	default:
		a.logger.Error("database request failed", "method", r.Method, "path", r.URL.Path, "error", err)
		writeError(w, http.StatusInternalServerError, "INTERNAL_ERROR", "服务暂时不可用，请稍后重试。")
	}
}

func decodeJSON(w http.ResponseWriter, r *http.Request, limit int64, target any) bool {
	mediaType, _, err := mime.ParseMediaType(r.Header.Get("Content-Type"))
	if err != nil || mediaType != "application/json" {
		writeError(w, http.StatusUnsupportedMediaType, "UNSUPPORTED_MEDIA_TYPE", "请使用 application/json 请求体。")
		return false
	}
	r.Body = http.MaxBytesReader(w, r.Body, limit)
	decoder := json.NewDecoder(r.Body)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		jsonFailure(w, err)
		return false
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err != nil {
			jsonFailure(w, err)
		} else {
			writeError(w, http.StatusBadRequest, "INVALID_JSON", "请求体只能包含一个 JSON 对象。")
		}
		return false
	}
	return true
}

func jsonFailure(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "BODY_TOO_LARGE", "请求体过大。")
		return
	}
	writeError(w, http.StatusBadRequest, "INVALID_JSON", "JSON 格式不正确、包含未知字段或字段类型不匹配。")
}

func machineID(w http.ResponseWriter, value string) (string, bool) {
	value = strings.ToLower(strings.TrimSpace(value))
	valid := len(value) == 36 && value != "00000000-0000-0000-0000-000000000000"
	if valid {
		for i, ch := range value {
			if i == 8 || i == 13 || i == 18 || i == 23 {
				valid = valid && ch == '-'
				continue
			}
			valid = valid && (ch >= '0' && ch <= '9' || ch >= 'a' && ch <= 'f')
		}
	}
	if !valid {
		writeError(w, http.StatusBadRequest, "INVALID_MACHINE_ID", "machineId 必须是有效的非空 UUID。")
	}
	return value, valid
}

func noteID(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := strconv.ParseInt(r.PathValue("id"), 10, 64)
	valid := err == nil && id > 0
	if !valid {
		writeError(w, http.StatusBadRequest, "INVALID_ID", "更新说明 ID 必须是正整数。")
	}
	return id, valid
}

func pagination(w http.ResponseWriter, r *http.Request) (int, int, bool) {
	limit, offset := 20, 0
	var err error
	if value := r.URL.Query().Get("limit"); value != "" {
		limit, err = strconv.Atoi(value)
		if err != nil || limit < 1 || limit > 100 {
			writeError(w, http.StatusBadRequest, "INVALID_PAGINATION", "limit 必须在 1 到 100 之间。")
			return 0, 0, false
		}
	}
	if value := r.URL.Query().Get("offset"); value != "" {
		offset, err = strconv.Atoi(value)
		if err != nil || offset < 0 || offset > 1_000_000 {
			writeError(w, http.StatusBadRequest, "INVALID_PAGINATION", "offset 必须在 0 到 1000000 之间。")
			return 0, 0, false
		}
	}
	return limit, offset, true
}
