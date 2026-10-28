package releasenotesmcp

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func fixtureClient(t *testing.T, handler http.HandlerFunc) *Client {
	t.Helper()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer "+testToken {
			t.Error("missing admin authorization")
		}
		if r.Method == http.MethodPost || r.Method == http.MethodPut {
			if r.Header.Get("Content-Type") != "application/json" {
				t.Error("missing JSON content type")
			}
		}
		w.Header().Set("Content-Type", "application/json")
		handler(w, r)
	}))
	t.Cleanup(server.Close)
	c, err := NewClient(Config{BaseURL: server.URL, AdminToken: testToken})
	if err != nil {
		t.Fatal(err)
	}
	return c
}

func ptr[T any](v T) *T { return &v }

func TestCreateDefaultsToDraftAndPreservesInt64ID(t *testing.T) {
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.Method != "POST" || r.URL.Path != adminPath {
			t.Errorf("unexpected route: %s %s", r.Method, r.URL.Path)
		}
		var body noteBody
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if body.Status != 0 || body.PublishedAt != nil {
			t.Error("create must default to draft")
		}
		w.WriteHeader(http.StatusCreated)
		_ = json.NewEncoder(w).Encode(wireNote{ID: 9223372036854775807, Version: body.Version, Title: body.Title, Status: body.Status})
	})
	n, err := c.create(context.Background(), CreateInput{Version: "1.2.3", Title: "更新说明"})
	if err != nil || n.ID != "9223372036854775807" || n.Status != 0 {
		t.Fatalf("unexpected create result: %+v %v", n, err)
	}
}

func TestUpdatePublishUnpublishAndDelete(t *testing.T) {
	note := wireNote{ID: 42, Version: "1.2.3", Title: "旧标题", ContentHTML: "<p>保留正文</p>", PublishedAt: ptr(int64(9999999999999))}
	var puts int
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != adminPath+"/42" {
			t.Errorf("unexpected path: %s", r.URL.Path)
		}
		switch r.Method {
		case "GET":
			_ = json.NewEncoder(w).Encode(note)
		case "PUT":
			var body noteBody
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Error(err)
			}
			puts++
			if body.Version != "1.2.3" || body.ContentHTML != "<p>保留正文</p>" {
				t.Error("omitted fields lost")
			}
			note.Title, note.ContentHTML, note.Status, note.PublishedAt = body.Title, body.ContentHTML, body.Status, body.PublishedAt
			_ = json.NewEncoder(w).Encode(note)
		case "DELETE":
			w.WriteHeader(http.StatusNoContent)
		default:
			t.Error("unexpected method")
		}
	})
	ctx := context.Background()
	n, err := c.update(ctx, UpdateInput{ID: "42", Title: ptr("新标题")})
	if err != nil || n.Title != "新标题" || n.PublishedAt == nil || *n.PublishedAt != 9999999999999 {
		t.Fatalf("partial update failed: %+v %v", n, err)
	}
	before := time.Now().UnixMilli()
	n, err = c.publish(ctx, PublishInput{ID: "42"})
	if err != nil || n.Status != 1 || n.PublishedAt == nil || *n.PublishedAt < before || *n.PublishedAt > time.Now().UnixMilli() {
		t.Fatal("publish must replace a future timestamp with now")
	}
	n, err = c.unpublish(ctx, IDInput{ID: "42"})
	if err != nil || n.Status != 2 || n.ContentHTML != "<p>保留正文</p>" {
		t.Fatal("unpublish lost content")
	}
	n, err = c.update(ctx, UpdateInput{ID: "42", ClearPublishedAt: true})
	if err != nil || n.PublishedAt != nil {
		t.Fatal("clearPublishedAt did not clear timestamp")
	}
	deleted, err := c.remove(ctx, IDInput{ID: "42"})
	if err != nil || !deleted.Deleted || puts != 4 {
		t.Fatal("delete or read-modify-write failed")
	}
}

func TestInputValidationAvoidsWrites(t *testing.T) {
	var requests atomic.Int32
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) { requests.Add(1); w.WriteHeader(500) })
	ctx := context.Background()
	for _, id := range []string{"0", "01", "-1", "../42", "9223372036854775808"} {
		if _, err := c.detail(ctx, IDInput{ID: id}); err == nil {
			t.Error("invalid ID accepted")
		}
	}
	if _, err := c.create(ctx, CreateInput{Version: "1.0.0", Title: "title", Status: ptr(1)}); err == nil {
		t.Error("published note without content accepted")
	}
	if _, err := c.create(ctx, CreateInput{Version: "1.0.0", Title: "title", ContentHTML: strings.Repeat("中", 400000)}); err == nil {
		t.Error("UTF-8 byte limit ignored")
	}
	if _, err := c.update(ctx, UpdateInput{ID: "42"}); err == nil {
		t.Error("empty update accepted")
	}
	if _, err := c.update(ctx, UpdateInput{ID: "42", PublishedAt: ptr(int64(1)), ClearPublishedAt: true}); err == nil {
		t.Error("conflicting timestamp arguments accepted")
	}
	if requests.Load() != 0 {
		t.Error("invalid input reached backend")
	}
}

func TestErrorsAndReflectedFieldsNeverExposeToken(t *testing.T) {
	for _, code := range []string{"UNAUTHORIZED", "ADMIN_DISABLED", "VERSION_EXISTS", "UNKNOWN-" + testToken} {
		t.Run(strings.Split(code, "-")[0], func(t *testing.T) {
			c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
				w.WriteHeader(401)
				_ = json.NewEncoder(w).Encode(map[string]any{"error": map[string]string{"code": code, "message": testToken}})
			})
			_, err := c.detail(context.Background(), IDInput{ID: "42"})
			if err == nil || strings.Contains(err.Error(), testToken) {
				t.Fatal("upstream error leaked a secret")
			}
		})
	}
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(wireNote{ID: 42, Version: "1.2.3", Title: testToken, ContentHTML: "<p>" + testToken + "</p>"})
	})
	n, err := c.detail(context.Background(), IDInput{ID: "42"})
	raw, _ := json.Marshal(n)
	if err != nil || strings.Contains(string(raw), testToken) {
		t.Fatal("reflected token not redacted")
	}
}

func TestRedirectsAreNotFollowed(t *testing.T) {
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { redirected.Add(1) }))
	defer target.Close()
	c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	})
	_, err := c.detail(context.Background(), IDInput{ID: "42"})
	if err == nil || redirected.Load() != 0 {
		t.Fatal("authenticated redirect was followed")
	}
}

type failingTransport struct{}

func (failingTransport) RoundTrip(*http.Request) (*http.Response, error) {
	return nil, fmt.Errorf("transport accidentally included %s", testToken)
}

func TestTransportErrorsAreSanitized(t *testing.T) {
	c, err := NewClient(Config{BaseURL: "https://example.invalid", AdminToken: testToken})
	if err != nil {
		t.Fatal(err)
	}
	c.http.Transport = failingTransport{}
	_, err = c.detail(context.Background(), IDInput{ID: "42"})
	if err == nil || strings.Contains(err.Error(), testToken) || !strings.Contains(err.Error(), "BACKEND_UNREACHABLE") {
		t.Fatal("raw transport error leaked")
	}
}

func TestMalformedSuccessResponsesAreRejected(t *testing.T) {
	for _, response := range []string{`null`, `{}`, `<html>upstream error</html>`, `{"id":43,"version":"1.2.3","title":"wrong record","status":0}`} {
		c := fixtureClient(t, func(w http.ResponseWriter, r *http.Request) { _, _ = w.Write([]byte(response)) })
		_, err := c.detail(context.Background(), IDInput{ID: "42"})
		if err == nil || !strings.Contains(err.Error(), "INVALID_RESPONSE") {
			t.Error("malformed success response accepted")
		}
	}
}
