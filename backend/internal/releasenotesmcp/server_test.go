package releasenotesmcp

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func TestMCPHandshakeSchemasAndToolCalls(t *testing.T) {
	var calls atomic.Int32
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if r.Method != "GET" || r.URL.Path != adminPath || r.URL.Query().Get("limit") != "20" || r.URL.Query().Get("offset") != "0" {
			t.Error("unexpected list request")
		}
		_, _ = w.Write([]byte(`{"items":[{"id":9223372036854775807,"version":"1.2.3","title":"更新","status":0,"contentHtml":"must not be returned","publishedAt":null,"createdAt":1,"updatedAt":2}],"total":1,"limit":20,"offset":0}`))
	})
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	ct, st := mcp.NewInMemoryTransports()
	ss, err := NewServer(c).Connect(ctx, st, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer ss.Close()
	session, err := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "1"}, nil).Connect(ctx, ct, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer session.Close()
	listed, err := session.ListTools(ctx, nil)
	if err != nil || len(listed.Tools) != 7 {
		t.Fatalf("tools/list: %v", err)
	}
	for _, tool := range listed.Tools {
		readOnly := tool.Name == "release_notes_list" || tool.Name == "release_notes_get"
		if tool.Annotations == nil || tool.Annotations.ReadOnlyHint != readOnly || tool.Annotations.OpenWorldHint == nil || *tool.Annotations.OpenWorldHint {
			t.Errorf("wrong annotations for %s", tool.Name)
		}
		if tool.OutputSchema == nil {
			t.Errorf("missing output schema for %s", tool.Name)
		}
	}
	if calls.Load() != 0 {
		t.Fatal("handshake or listing contacted backend")
	}
	result, err := session.CallTool(ctx, &mcp.CallToolParams{Name: "release_notes_list", Arguments: map[string]any{}})
	if err != nil || result.IsError {
		t.Fatalf("tools/call: %v %+v", err, result)
	}
	raw, err := json.Marshal(result.StructuredContent)
	if err != nil || !strings.Contains(string(raw), `"id":"9223372036854775807"`) || strings.Contains(string(raw), "must not be returned") {
		t.Fatal("structured output lost ID precision or exposed HTML in list")
	}
	for _, tc := range []struct {
		name string
		args map[string]any
	}{
		{"release_notes_list", map[string]any{"limit": 0}},
		{"release_notes_list", map[string]any{"unknown": true}},
		{"release_notes_get", map[string]any{"id": 42}},
		{"release_notes_get", map[string]any{"id": "../42"}},
		{"release_notes_create", map[string]any{"version": "1.2.3"}},
	} {
		res, err := session.CallTool(ctx, &mcp.CallToolParams{Name: tc.name, Arguments: tc.args})
		if err == nil && !res.IsError {
			t.Errorf("schema accepted invalid input for %s", tc.name)
		}
	}
	if calls.Load() != 1 {
		t.Fatal("schema validation allowed invalid requests through")
	}
}
