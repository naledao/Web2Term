package httpapi

import (
	"context"
	"encoding/json"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type peer struct {
	userID    int64
	id        string
	agentID   string
	conn      *websocket.Conn
	terminals map[string]*peer
}

// All registry changes and device presence writes share one lock. In particular,
// an old agent's deferred cleanup cannot mark its replacement offline.
type hub struct {
	mu       sync.Mutex
	wg       sync.WaitGroup
	devices  DeviceStore
	agents   map[string]*peer
	desktops map[string]*peer
	bindings map[string]*peer
	closing  bool
}

func newHub(devices DeviceStore) *hub {
	return &hub{devices: devices, agents: make(map[string]*peer),
		desktops: make(map[string]*peer), bindings: make(map[string]*peer)}
}

func (h *hub) enterAgent() bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return false
	}
	h.wg.Add(1)
	return true
}

func (h *hub) installAgent(ctx context.Context, p *peer, name string) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return false, nil
	}
	ok, err := h.devices.Connect(ctx, p.userID, p.id, name)
	if err != nil || !ok {
		return false, err
	}
	previous := h.agents[p.id]
	h.agents[p.id] = p
	if previous != nil {
		go previous.conn.Close(websocket.StatusNormalClosure, "replaced by new connection")
		if desktop := h.bindings[p.id]; desktop != nil && desktop.conn != nil {
			go desktop.conn.CloseNow()
		}
	}
	return true, nil
}

func (h *hub) leaveAgent(p *peer) error {
	defer h.wg.Done()
	h.mu.Lock()
	if h.agents[p.id] != p {
		h.mu.Unlock()
		return nil
	}
	delete(h.agents, p.id)
	desktop := h.bindings[p.id]
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	err := h.devices.Disconnect(ctx, p.userID, p.id)
	h.mu.Unlock()
	if desktop != nil && desktop.conn != nil {
		_ = desktop.conn.CloseNow()
	}
	return err
}

func (h *hub) heartbeat(ctx context.Context, p *peer) (bool, error) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.agents[p.id] != p || h.closing {
		return false, nil
	}
	return h.devices.Heartbeat(ctx, p.userID, p.id)
}

// Reserve before HTTP upgrade so simultaneous desktop handshakes cannot both
// succeed for the same device. A failed upgrade releases this reservation.
func (h *hub) reserveDesktop(p *peer) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing {
		return 503
	}
	if h.bindings[p.agentID] != nil {
		return 409
	}
	previous := h.desktops[p.id]
	if previous != nil && previous.userID != p.userID {
		return 409
	}
	if previous != nil {
		if h.bindings[previous.agentID] == previous {
			delete(h.bindings, previous.agentID)
		}
		if previous.conn != nil {
			go previous.conn.Close(websocket.StatusNormalClosure, "replaced by new connection")
		}
	}
	h.desktops[p.id] = p
	h.bindings[p.agentID] = p
	h.wg.Add(1)
	return 0
}

func (h *hub) activateDesktop(p *peer, conn *websocket.Conn) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	if h.closing || h.desktops[p.id] != p || h.bindings[p.agentID] != p {
		return false
	}
	p.conn = conn
	return true
}

func (h *hub) leaveDesktop(p *peer) {
	defer h.wg.Done()
	h.mu.Lock()
	var cleanup []struct {
		id    string
		agent *peer
	}
	for id, agent := range p.terminals {
		if h.agents[p.agentID] == agent && agent.userID == p.userID {
			cleanup = append(cleanup, struct {
				id    string
				agent *peer
			}{id, agent})
		}
	}
	p.terminals = nil
	if h.desktops[p.id] == p {
		delete(h.desktops, p.id)
	}
	if h.bindings[p.agentID] == p {
		delete(h.bindings, p.agentID)
	}
	h.mu.Unlock()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	for _, session := range cleanup {
		data, _ := json.Marshal(struct {
			Version   int    `json:"version"`
			Type      string `json:"type"`
			SessionID string `json:"session_id"`
		}{1, "terminal_close", session.id})
		if writeSocket(ctx, session.agent.conn, data) != nil {
			// A transport that cannot accept cleanup cannot safely keep its old shells.
			_ = session.agent.conn.CloseNow()
			break
		}
	}
}

// Register opens before forwarding, so disconnects during terminal startup are also cleaned up.
// Entries capture the actual agent connection; cleanup must never target its replacement.
func (h *hub) terminalTarget(p *peer, fromAgent bool, messageType, sessionID, code string) (*websocket.Conn, bool) {
	h.mu.Lock()
	defer h.mu.Unlock()
	var other *peer
	if fromAgent && h.agents[p.id] == p {
		other = h.bindings[p.id]
	} else if !fromAgent && h.desktops[p.id] == p && h.bindings[p.agentID] == p {
		other = h.agents[p.agentID]
	}
	if other == nil || other.userID != p.userID || other.conn == nil {
		return nil, true
	}
	if sessionID != "" && normalizeUUID(sessionID) == sessionID {
		if !fromAgent && messageType == "terminal_open" {
			if p.terminals == nil {
				p.terminals = make(map[string]*peer)
			}
			if p.terminals[sessionID] == nil && len(p.terminals) >= 128 {
				return nil, false
			}
			p.terminals[sessionID] = other
		} else if fromAgent && other.terminals[sessionID] == p && (messageType == "terminal_exit" ||
			(messageType == "terminal_error" && (code == "TERMINAL_START_FAILED" || code == "TERMINAL_LIMIT_REACHED" || code == "SESSION_CLOSED" || code == "SESSION_NOT_FOUND"))) {
			delete(other.terminals, sessionID)
		}
	}
	return other.conn, true
}

func (h *hub) online(id string) bool {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.agents[id] != nil
}

func (h *hub) shutdown() {
	h.mu.Lock()
	h.closing = true
	var connections []*websocket.Conn
	for _, p := range h.agents {
		connections = append(connections, p.conn)
	}
	for _, p := range h.desktops {
		if p.conn != nil {
			connections = append(connections, p.conn)
		}
	}
	h.mu.Unlock()
	for _, conn := range connections {
		_ = conn.CloseNow()
	}
	h.wg.Wait()
}
