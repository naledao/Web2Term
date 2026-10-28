package httpapi

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/coder/websocket"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/store"
)

const testDevice = "aabbccdd-1234-5678-9abc-0123456789ab"
const testDesktop = "11223344-1234-5678-9abc-0123456789ab"

type fixtureUsers struct{}

func (fixtureUsers) Introspect(_ context.Context, authorization string) (int64, error) {
	switch authorization {
	case "Bearer owner":
		return 42, nil
	case "Bearer other":
		return 43, nil
	case "Bearer outage":
		return 0, &auth.Failure{Status: 503}
	default:
		return 0, &auth.Failure{Status: 401}
	}
}

func (fixtureUsers) SendCode(context.Context, string) error { return nil }
func (fixtureUsers) Login(context.Context, string, string) (auth.LoginResponse, error) {
	return auth.LoginResponse{}, &auth.Failure{Status: 400, Code: "LOGIN_CODE_INCORRECT"}
}

func fixture(t *testing.T) (*Server, *store.Store) {
	t.Helper()
	db, err := store.Open(context.Background(), filepath.Join(t.TempDir(), "devices.db"))
	if err != nil {
		t.Fatal(err)
	}
	api := New(db, fixtureUsers{}, slog.New(slog.NewTextHandler(io.Discard, nil)))
	t.Cleanup(func() { api.Shutdown(); db.Close() })
	return api, db
}

func request(t *testing.T, h http.Handler, method, path, body, auth string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.Header.Set("Authorization", auth)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestHTTPContractAndOwnerScopedRename(t *testing.T) {
	api, db := fixture(t)
	h := api.Handler()
	if _, err := db.Connect(context.Background(), 42, testDevice, "old"); err != nil {
		t.Fatal(err)
	}
	for _, test := range []struct {
		method, path, body, auth string
		status                   int
	}{
		{"POST", "/api/user/login/code", `{"email":"fixture@example.invalid"}`, "", 204},
		{"POST", "/api/user/login", `{"email":"fixture@example.invalid","code":"000000"}`, "", 400},
		{"GET", "/api/user/devices", "", "", 401},
		{"GET", "/api/user/devices", "", "Bearer outage", 503},
		{"PATCH", "/api/user/devices/" + strings.ToUpper(testDevice), `{"deviceName":"  我的设备  "}`, "Bearer owner", 204},
		{"PATCH", "/api/user/devices/" + testDevice, `{"deviceName":"not mine"}`, "Bearer other", 404},
		{"PATCH", "/api/user/devices/" + testDevice, `{"deviceName":" "}`, "Bearer owner", 400},
		{"PATCH", "/api/user/devices/" + testDevice, `{"deviceName":"first\nsecond"}`, "Bearer owner", 400},
		{"PATCH", "/api/user/devices/" + testDevice, `{"deviceName":"` + strings.Repeat("x", 101) + `"}`, "Bearer owner", 400},
		{"PATCH", "/api/user/devices/not-a-uuid", `{"deviceName":"name"}`, "Bearer owner", 400},
		{"PATCH", "/api/user/devices/" + testDevice, `null`, "Bearer owner", 400},
		{"PATCH", "/api/user/devices/" + testDevice, `{"deviceName":"changed"} {}`, "Bearer owner", 400},
		{"POST", "/api/user/login", `{`, "", 400},
		{"POST", "/api/user/login", `{"email":"` + strings.Repeat("x", 17<<10) + `"}`, "", 413},
	} {
		w := request(t, h, test.method, test.path, test.body, test.auth)
		if w.Code != test.status {
			t.Errorf("%s %s: want %d got %d (%s)", test.method, test.path, test.status, w.Code, w.Body.String())
		}
	}
	w := request(t, h, "GET", "/api/user/devices", "", "Bearer owner")
	var devices []store.Device
	if err := json.Unmarshal(w.Body.Bytes(), &devices); err != nil || len(devices) != 1 ||
		devices[0].DeviceName != "我的设备" || devices[0].OnlineStatus != 0 {
		t.Fatalf("device list must use live registry status: %s, %v", w.Body.String(), err)
	}
	w = request(t, h, "GET", "/api/user/devices", "", "Bearer other")
	if w.Code != 200 || w.Body.String() != "[]" {
		t.Fatalf("other owner's list: %d %s", w.Code, w.Body.String())
	}
}

func websocketServer(t *testing.T) (*Server, string) {
	t.Helper()
	api, _ := fixture(t)
	server := httptest.NewServer(api.Handler())
	t.Cleanup(func() { api.Shutdown(); server.Close() })
	return api, "ws" + strings.TrimPrefix(server.URL, "http")
}

func dial(t *testing.T, url, role, id, auth string) *websocket.Conn {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	conn, res, err := websocket.Dial(ctx, url+"/ws/"+role, &websocket.DialOptions{HTTPHeader: socketHeaders(role, id, auth)})
	if err != nil {
		status := 0
		if res != nil {
			status = res.StatusCode
		}
		t.Fatalf("dial %s: HTTP %d, %v", role, status, err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func socketHeaders(role, id, auth string) http.Header {
	h := http.Header{"Authorization": {auth}}
	if role == "agent" {
		h.Set("X-Device-Id", id)
	} else {
		h.Set("X-Desktop-Client-Id", id)
		h.Set("X-Agent-Id", testDevice)
	}
	return h
}

func send(t *testing.T, conn *websocket.Conn, message string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, []byte(message)); err != nil {
		t.Fatal(err)
	}
}

func receive(t *testing.T, conn *websocket.Conn, expected string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	kind, data, err := conn.Read(ctx)
	if err != nil || kind != websocket.MessageText || !bytes.Equal(data, []byte(expected)) {
		t.Fatalf("message: want %s got %s (%v)", expected, data, err)
	}
}

func heartbeat(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	send(t, conn, `{"type":"heartbeat"}`)
	receive(t, conn, `{"type":"heartbeat_ack"}`)
}

func TestWebSocketRelayReplacementAndInvalidJSON(t *testing.T) {
	api, url := websocketServer(t)
	agent := dial(t, url, "agent", testDevice, "Bearer owner")
	heartbeat(t, agent)
	desktop := dial(t, url, "desktop", testDesktop, "Bearer owner")
	command := `{"type":"terminal_open","requestId":"fixture","agentId":"ignored-client-field"}`
	send(t, desktop, command)
	receive(t, agent, command)
	output := `{"type":"terminal_output","terminalId":"fixture","data":"你好\n"}`
	send(t, agent, output)
	receive(t, desktop, output)

	// Replacement must not let the old connection's cleanup clear presence.
	replacement := dial(t, url, "agent", testDevice, "Bearer owner")
	heartbeat(t, replacement)
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	if _, _, err := agent.Read(ctx); websocket.CloseStatus(err) != websocket.StatusNormalClosure {
		t.Fatalf("old agent close: %v", err)
	}
	heartbeat(t, replacement)
	if !api.hub.online(testDevice) {
		t.Fatal("old connection cleared replacement presence")
	}
	send(t, desktop, command)
	receive(t, replacement, command)
	send(t, desktop, `{broken`)
	if _, _, err := desktop.Read(ctx); websocket.CloseStatus(err) != websocket.StatusUnsupportedData {
		t.Fatalf("invalid JSON close: %v", err)
	}
	heartbeat(t, replacement)
}

func TestWebSocketRejectsUnauthorizedForeignAndBusyDevices(t *testing.T) {
	_, url := websocketServer(t)
	agent := dial(t, url, "agent", testDevice, "Bearer owner")
	heartbeat(t, agent)
	dial(t, url, "desktop", testDesktop, "Bearer owner")
	for _, test := range []struct {
		role, id, auth string
		status         int
	}{
		{"agent", testDevice, "", 401},
		{"agent", testDevice, "Bearer other", 403},
		{"agent", testDevice, "Bearer outage", 503},
		{"desktop", testDesktop, "Bearer other", 403},
		{"desktop", testDesktop, "Bearer owner", 409},
		{"agent", "invalid", "Bearer owner", 400},
	} {
		ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		conn, res, err := websocket.Dial(ctx, url+"/ws/"+test.role, &websocket.DialOptions{HTTPHeader: socketHeaders(test.role, test.id, test.auth)})
		cancel()
		if conn != nil {
			conn.CloseNow()
		}
		if err == nil || res == nil || res.StatusCode != test.status {
			t.Errorf("%s %s: wanted HTTP %d, got %v, %v", test.role, test.auth, test.status, res, err)
		}
	}
}

func TestConcurrentDesktopHandshakesReserveOneAgent(t *testing.T) {
	_, url := websocketServer(t)
	agent := dial(t, url, "agent", testDevice, "Bearer owner")
	heartbeat(t, agent)
	var wg sync.WaitGroup
	winners := make(chan *websocket.Conn, 8)
	for i := 0; i < 8; i++ {
		wg.Go(func() {
			ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
			defer cancel()
			id := fmt.Sprintf("%08x-1234-5678-9abc-0123456789ab", i+1)
			conn, res, err := websocket.Dial(ctx, url+"/ws/desktop", &websocket.DialOptions{HTTPHeader: socketHeaders("desktop", id, "Bearer owner")})
			if err == nil {
				winners <- conn
			} else if res == nil || res.StatusCode != 409 {
				t.Errorf("unexpected concurrent handshake result: %v, %v", res, err)
			}
		})
	}
	wg.Wait()
	close(winners)
	if len(winners) != 1 {
		t.Errorf("expected one successful handshake, got %d", len(winners))
	}
	for conn := range winners {
		conn.CloseNow()
	}
}

func TestFailedUpgradeReleasesDesktopReservation(t *testing.T) {
	api, db := fixture(t)
	if ok, err := db.Connect(context.Background(), 42, testDevice, "device"); err != nil || !ok {
		t.Fatalf("create device: %v, %v", ok, err)
	}
	// An authenticated HTTP request without WebSocket upgrade headers must not
	// leave a permanent busy binding after Accept rejects it.
	r := httptest.NewRequest("GET", "/ws/desktop", nil)
	r.Header = socketHeaders("desktop", testDesktop, "Bearer owner")
	w := httptest.NewRecorder()
	api.Handler().ServeHTTP(w, r)
	if w.Code != 426 {
		t.Fatalf("expected 426, got %d", w.Code)
	}
	p := &peer{userID: 42, id: testDesktop, agentID: testDevice}
	if status := api.hub.reserveDesktop(p); status != 0 {
		t.Fatalf("failed upgrade retained its reservation: %d", status)
	}
	api.hub.leaveDesktop(p)
}
