package httpapi

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/coder/websocket"

	"web2term/backend/internal/auth"
)

func (s *Server) agent(w http.ResponseWriter, r *http.Request) {
	id := normalizeUUID(r.Header.Get("X-Device-Id"))
	if id == "" {
		writeError(w, http.StatusBadRequest, "invalid device id")
		return
	}
	name := strings.TrimSpace(r.Header.Get("X-Device-Name"))
	if name == "" {
		name = "agent-" + id[:8]
	}
	if !validName(name) {
		writeError(w, http.StatusBadRequest, "invalid device name")
		return
	}
	userID, ok := s.socketIdentity(w, r)
	if !ok {
		return
	}
	if !s.allowDevice(w, r, userID, id, true) {
		return
	}
	if !s.hub.enterAgent() {
		writeError(w, http.StatusServiceUnavailable, "server shutting down")
		return
	}
	p := &peer{userID: userID, id: id}
	defer func() {
		if err := s.hub.leaveAgent(p); err != nil {
			s.log.Error("device disconnect status update failed", "deviceId", id)
		}
	}()
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	p.conn = conn
	// Hijacked connections must not inherit the HTTP request's cancellation.
	socketCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	ok, err = s.hub.installAgent(socketCtx, p, name)
	if err != nil {
		_ = conn.Close(websocket.StatusInternalError, "device registration failed")
		return
	}
	if !ok {
		_ = conn.Close(websocket.StatusPolicyViolation, "device not allowed")
		return
	}
	s.log.Info("agent connected", "userId", userID, "deviceId", id)
	s.relay(socketCtx, p, true)
	s.log.Info("agent disconnected", "deviceId", id)
}

func (s *Server) desktop(w http.ResponseWriter, r *http.Request) {
	id := normalizeUUID(r.Header.Get("X-Desktop-Client-Id"))
	agentID := normalizeUUID(r.Header.Get("X-Agent-Id"))
	if id == "" || agentID == "" {
		writeError(w, http.StatusBadRequest, "invalid desktop or agent id")
		return
	}
	userID, ok := s.socketIdentity(w, r)
	if !ok {
		return
	}
	if !s.allowDevice(w, r, userID, agentID, false) {
		return
	}
	p := &peer{userID: userID, id: id, agentID: agentID}
	if status := s.hub.reserveDesktop(p); status != 0 {
		writeError(w, status, http.StatusText(status))
		return
	}
	defer s.hub.leaveDesktop(p)
	conn, err := websocket.Accept(w, r, nil)
	if err != nil {
		return
	}
	defer conn.CloseNow()
	conn.SetReadLimit(64 << 10)
	if !s.hub.activateDesktop(p, conn) {
		_ = conn.Close(websocket.StatusGoingAway, "connection replaced or server shutting down")
		return
	}
	socketCtx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.log.Info("desktop connected", "userId", userID, "desktopClientId", id, "agentId", agentID)
	s.relay(socketCtx, p, false)
	s.log.Info("desktop disconnected", "desktopClientId", id)
}

func (s *Server) socketIdentity(w http.ResponseWriter, r *http.Request) (int64, bool) {
	id, err := s.users.Introspect(r.Context(), r.Header.Get("Authorization"))
	if err == nil {
		return id, true
	}
	failure := auth.FailureOf(err)
	status := http.StatusServiceUnavailable
	if failure.Status == http.StatusUnauthorized {
		status = http.StatusUnauthorized
	} else if failure.Status == http.StatusBadGateway {
		status = http.StatusBadGateway
	}
	writeError(w, status, http.StatusText(status))
	return 0, false
}

func (s *Server) allowDevice(w http.ResponseWriter, r *http.Request, userID int64, id string, allowNew bool) bool {
	state, found, err := s.devices.Auth(r.Context(), id)
	if err != nil {
		writeError(w, http.StatusInternalServerError, "device lookup failed")
	} else if !found && !allowNew {
		writeError(w, http.StatusNotFound, "device not found")
	} else if found && (state.UserID != userID || !state.Enabled) {
		writeError(w, http.StatusForbidden, "device not allowed")
	} else {
		return true
	}
	return false
}

func (s *Server) relay(ctx context.Context, p *peer, fromAgent bool) {
	for {
		readCtx := ctx
		cancel := func() {}
		if fromAgent {
			// The existing agent sends a heartbeat every 20s. A dead transport must
			// eventually leave the online registry even without a TCP close frame.
			readCtx, cancel = context.WithTimeout(ctx, 90*time.Second)
		}
		kind, data, err := p.conn.Read(readCtx)
		cancel()
		if err != nil {
			return
		}
		if kind != websocket.MessageText || !utf8.Valid(data) {
			_ = p.conn.Close(websocket.StatusUnsupportedData, "JSON text required")
			return
		}
		var message struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(data, &message) != nil || strings.TrimSpace(message.Type) == "" {
			_ = p.conn.Close(websocket.StatusUnsupportedData, "invalid json or missing message type")
			return
		}
		if fromAgent && message.Type == "heartbeat" {
			ok, err := s.hub.heartbeat(ctx, p)
			if err != nil {
				_ = p.conn.Close(websocket.StatusInternalError, "heartbeat update failed")
				return
			}
			if !ok {
				_ = p.conn.Close(websocket.StatusPolicyViolation, "device not allowed")
				return
			}
			if writeSocket(ctx, p.conn, []byte(`{"type":"heartbeat_ack"}`)) != nil {
				return
			}
			continue
		}
		if target := s.hub.target(p, fromAgent); target != nil {
			if err := writeSocket(ctx, target, data); err != nil {
				// Losing the target must not disconnect an otherwise healthy agent.
				_ = target.CloseNow()
			}
		}
	}
}

func writeSocket(ctx context.Context, conn *websocket.Conn, data []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return conn.Write(ctx, websocket.MessageText, data)
}
