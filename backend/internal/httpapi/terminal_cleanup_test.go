package httpapi

// User-run regressions: go test ./internal/httpapi
// Only an in-process fixture backend, temporary database and loopback sockets; no real service or shell.
import (
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/coder/websocket"
)

func waitDesktopReleased(t *testing.T, api *Server, id string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	ticker := time.NewTicker(5 * time.Millisecond)
	defer ticker.Stop()
	for {
		api.hub.mu.Lock()
		released := api.hub.desktops[id] == nil
		api.hub.mu.Unlock()
		if released {
			return
		}
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("desktop registry was not released")
		}
	}
}

func TestDesktopDisconnectClosesPendingTerminal(t *testing.T) {
	_, url := websocketServer(t)
	agent := dial(t, url, "agent", testDevice, "Bearer owner")
	heartbeat(t, agent)
	desktop := dial(t, url, "desktop", testDesktop, "Bearer owner")
	const id = "00000000-1234-5678-9abc-0123456789ab"
	const open = `{"version":1,"type":"terminal_open","session_id":"` + id + `","payload":{}}`
	send(t, desktop, open)
	receive(t, agent, open)
	_ = desktop.CloseNow()
	receive(t, agent, `{"version":1,"type":"terminal_close","session_id":"`+id+`"}`)
	heartbeat(t, agent)
}

func TestAgentDisconnectClosesDesktopTransport(t *testing.T) {
	_, url := websocketServer(t)
	agent := dial(t, url, "agent", testDevice, "Bearer owner")
	heartbeat(t, agent)
	desktop := dial(t, url, "desktop", testDesktop, "Bearer owner")
	_ = agent.CloseNow()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := desktop.Read(ctx); err == nil {
		t.Fatal("desktop stayed connected to a missing agent")
	}
}

func trackingFixture() (*hub, *peer, *peer) {
	h := newHub(nil)
	agent := &peer{id: testDevice, userID: 1, conn: &websocket.Conn{}}
	desktop := &peer{id: testDesktop, agentID: testDevice, userID: 1, conn: &websocket.Conn{}}
	h.agents[testDevice] = agent
	h.desktops[testDesktop] = desktop
	h.bindings[testDevice] = desktop
	return h, agent, desktop
}

func TestTerminalTrackingBoundsAndRelease(t *testing.T) {
	h, agent, desktop := trackingFixture()
	for n := 0; n < 128; n++ {
		id := fmt.Sprintf("%08d-1234-5678-9abc-0123456789ab", n)
		if target, ok := h.terminalTarget(desktop, false, "terminal_open", id, ""); !ok || target != agent.conn {
			t.Fatal("open was not tracked")
		}
	}
	if _, ok := h.terminalTarget(desktop, false, "terminal_open", "99999999-1234-5678-9abc-0123456789ab", ""); ok {
		t.Fatal("unbounded terminal tracking")
	}
	const id = "00000000-1234-5678-9abc-0123456789ab"
	h.terminalTarget(agent, true, "terminal_error", id, "SESSION_EXISTS")
	if len(desktop.terminals) != 128 {
		t.Fatal("duplicate open removed a live terminal")
	}
	h.terminalTarget(agent, true, "terminal_exit", id, "")
	if len(desktop.terminals) != 127 {
		t.Fatal("exit did not release tracking")
	}
	for _, code := range []string{"TERMINAL_LIMIT_REACHED", "TERMINAL_START_FAILED", "SESSION_CLOSED", "SESSION_NOT_FOUND"} {
		h.terminalTarget(desktop, false, "terminal_open", id, "")
		h.terminalTarget(agent, true, "terminal_error", id, code)
		if desktop.terminals[id] != nil {
			t.Fatalf("%s did not release a failed open", code)
		}
	}
}

func TestRetiredDesktopNeverClosesTerminalsOnReplacementAgent(t *testing.T) {
	h, old, desktop := trackingFixture()
	h.terminalTarget(desktop, false, "terminal_open", "00000000-1234-5678-9abc-0123456789ab", "")
	h.agents[testDevice] = &peer{id: testDevice, userID: 1, conn: &websocket.Conn{}}
	h.wg.Add(1)
	h.leaveDesktop(desktop) // Must not write to either of these deliberately unusable socket fixtures.
	if h.agents[testDevice] == old || h.bindings[testDevice] != nil {
		t.Fatal("replacement registry corrupted")
	}
}
