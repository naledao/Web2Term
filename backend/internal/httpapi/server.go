package httpapi

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"regexp"
	"strings"
	"unicode"
	"unicode/utf16"
	"unicode/utf8"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/releasenotes"
	"web2term/backend/internal/store"
)

type DeviceStore interface {
	Auth(context.Context, string) (store.AuthState, bool, error)
	Connect(context.Context, int64, string, string) (bool, error)
	Heartbeat(context.Context, int64, string) (bool, error)
	Disconnect(context.Context, int64, string) error
	Rename(context.Context, int64, string, string) (bool, error)
	List(context.Context, int64) ([]store.Device, error)
}

type AuthService interface {
	SendCode(context.Context, string) error
	Login(context.Context, string, string) (auth.LoginResponse, error)
	Introspect(context.Context, string) (int64, error)
}

type Server struct {
	devices      DeviceStore
	users        AuthService
	hub          *hub
	log          *slog.Logger
	limits       *loginLimits
	releaseNotes http.Handler
}

type Option func(*Server)

// Mount the release-note API on the same listener and use the caller's database.
func WithReleaseNotes(database *store.Store, adminToken string) Option {
	return func(s *Server) { s.releaseNotes = releasenotes.New(database, adminToken, s.log) }
}

func New(devices DeviceStore, users AuthService, log *slog.Logger, options ...Option) *Server {
	s := &Server{devices: devices, users: users, hub: newHub(devices), log: log, limits: newLoginLimits()}
	for _, option := range options {
		option(s)
	}
	return s
}

func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	if s.releaseNotes != nil {
		mux.Handle("/api/v1/release-notes", s.releaseNotes)
		mux.Handle("/api/v1/release-notes/", s.releaseNotes)
		mux.Handle("/api/v1/admin/release-notes", s.releaseNotes)
		mux.Handle("/api/v1/admin/release-notes/", s.releaseNotes)
	}
	mux.HandleFunc("POST /api/user/login/code", s.loginCode)
	mux.HandleFunc("POST /api/user/login", s.login)
	mux.HandleFunc("GET /api/user/devices", s.listDevices)
	mux.HandleFunc("PATCH /api/user/devices/{deviceId}", s.renameDevice)
	mux.HandleFunc("GET /ws/agent", s.agent)
	mux.HandleFunc("GET /ws/desktop", s.desktop)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]string{"status": "ok"})
	})
	return mux
}

func (s *Server) Shutdown() { s.hub.shutdown() }

func (s *Server) loginCode(w http.ResponseWriter, r *http.Request) {
	if !s.limits.allow(r.RemoteAddr, "code", 5) {
		writeJSON(w, 429, map[string]string{"code": "LOGIN_CODE_TOO_FREQUENT", "message": "验证码发送过于频繁"})
		return
	}
	var payload struct {
		Email string `json:"email"`
	}
	if !decode(w, r, &payload) {
		return
	}
	if err := s.users.SendCode(r.Context(), payload.Email); err != nil {
		writeFailure(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	if !s.limits.allow(r.RemoteAddr, "login", 30) {
		writeJSON(w, 429, map[string]string{"code": "RATE_LIMITED", "message": "登录尝试过于频繁"})
		return
	}
	var payload struct {
		Email string `json:"email"`
		Code  string `json:"code"`
	}
	if !decode(w, r, &payload) {
		return
	}
	response, err := s.users.Login(r.Context(), payload.Email, payload.Code)
	if err != nil {
		writeFailure(w, err)
		return
	}
	writeJSON(w, http.StatusOK, response)
}

func (s *Server) listDevices(w http.ResponseWriter, r *http.Request) {
	userID, err := s.users.Introspect(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	devices, err := s.devices.List(r.Context(), userID)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "device query failed")
		return
	}
	for i := range devices {
		devices[i].OnlineStatus = 0
		if s.hub.online(devices[i].DeviceID) {
			devices[i].OnlineStatus = 1
		}
	}
	writeJSON(w, http.StatusOK, devices)
}

func (s *Server) renameDevice(w http.ResponseWriter, r *http.Request) {
	userID, err := s.users.Introspect(r.Context(), r.Header.Get("Authorization"))
	if err != nil {
		writeFailure(w, err)
		return
	}
	id := normalizeUUID(r.PathValue("deviceId"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid device id")
		return
	}
	var payload struct {
		DeviceName string `json:"deviceName"`
	}
	if !decode(w, r, &payload) {
		return
	}
	name := strings.TrimSpace(payload.DeviceName)
	if !validName(name) {
		writeError(w, http.StatusBadRequest, "invalid device name")
		return
	}
	ok, err := s.devices.Rename(r.Context(), userID, id, name)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "device rename failed")
	} else if !ok {
		writeError(w, http.StatusNotFound, "device not found")
	} else {
		w.WriteHeader(http.StatusNoContent)
	}
}

var uuidPattern = regexp.MustCompile(`(?i)^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)

func normalizeUUID(raw string) string {
	value := strings.TrimSpace(raw)
	if !uuidPattern.MatchString(value) {
		return ""
	}
	return strings.ToLower(value)
}

func validName(name string) bool {
	return name != "" && utf8.ValidString(name) && len(utf16.Encode([]rune(name))) <= 100 &&
		strings.IndexFunc(name, unicode.IsControl) == -1
}

func decode(w http.ResponseWriter, r *http.Request, target any) bool {
	r.Body = http.MaxBytesReader(w, r.Body, 16<<10)
	d := json.NewDecoder(r.Body)
	var body json.RawMessage
	if err := d.Decode(&body); err != nil {
		decodeError(w, err)
		return false
	}
	if len(body) == 0 || body[0] != '{' || json.Unmarshal(body, target) != nil {
		writeError(w, http.StatusBadRequest, "invalid JSON object")
		return false
	}
	if err := d.Decode(new(any)); err != io.EOF {
		decodeError(w, err)
		return false
	}
	return true
}

func decodeError(w http.ResponseWriter, err error) {
	var tooLarge *http.MaxBytesError
	if errors.As(err, &tooLarge) {
		writeError(w, http.StatusRequestEntityTooLarge, "request too large")
	} else {
		writeError(w, http.StatusBadRequest, "invalid JSON body")
	}
}

func writeFailure(w http.ResponseWriter, err error) {
	failure := auth.FailureOf(err)
	writeJSON(w, failure.Status, map[string]string{"code": failure.Code, "message": failure.Message})
}

func writeError(w http.ResponseWriter, status int, message string) {
	writeJSON(w, status, map[string]string{"message": message})
}

func writeJSON(w http.ResponseWriter, status int, body any) {
	data, _ := json.Marshal(body)
	writeBody(w, status, data)
}

func writeBody(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Cache-Control", "no-store")
	if len(body) > 0 && status != http.StatusNoContent {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
	}
	w.WriteHeader(status)
	if status != http.StatusNoContent {
		_, _ = w.Write(body)
	}
}
