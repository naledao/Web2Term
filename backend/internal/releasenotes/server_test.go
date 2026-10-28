package releasenotes

import (
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"web2term/backend/internal/store"
)

const testMachine = "f15f800e-0123-4123-8123-123456789abc"
const otherMachine = "f15f800e-0123-4123-8123-123456789abd"
const adminToken = "test-only-admin-token"

func testHandler(t *testing.T, token string) http.Handler {
	t.Helper()
	db, err := store.Open(t.Context(), filepath.Join(t.TempDir(), "notes.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return New(db, token, slog.New(slog.NewTextHandler(io.Discard, nil)))
}

func request(t *testing.T, handler http.Handler, method, path, body, token string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	if body != "" {
		r.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, r)
	return w
}

func expectStatus(t *testing.T, response *httptest.ResponseRecorder, want int) {
	t.Helper()
	if response.Code != want {
		t.Fatalf("HTTP %d, want %d: %s", response.Code, want, response.Body.String())
	}
}

func decode[T any](t *testing.T, response *httptest.ResponseRecorder) T {
	t.Helper()
	var value T
	if err := json.Unmarshal(response.Body.Bytes(), &value); err != nil {
		t.Fatal(err)
	}
	return value
}

func TestPublicFlowPreservesHTMLAndSeparatesMachines(t *testing.T) {
	h := testHandler(t, adminToken)
	html := "<article><h3>新增</h3><p>支持 A & B，原样保留。</p></article>"
	body, _ := json.Marshal(map[string]any{"version": "v0.1.189", "title": "更新说明", "contentHtml": html, "status": 1})
	created := request(t, h, "POST", "/api/v1/admin/release-notes", string(body), adminToken)
	expectStatus(t, created, http.StatusCreated)
	note := decode[store.Note](t, created)
	if note.Version != "0.1.189" || note.ContentHTML != html {
		t.Fatalf("created note: %+v", note)
	}
	if created.Header().Get("Location") != fmt.Sprintf("/api/v1/admin/release-notes/%d", note.ID) {
		t.Fatal("missing Location")
	}
	path := fmt.Sprintf("/api/v1/release-notes/%d", note.ID)
	detailResponse := request(t, h, "GET", path+"?machineId="+testMachine, "", "")
	expectStatus(t, detailResponse, http.StatusOK)
	detail := decode[store.Detail](t, detailResponse)
	if detail.ContentHTML != html || detail.IsRead {
		t.Fatalf("detail: %+v", detail)
	}
	listPath := "/api/v1/release-notes?machineId=" + testMachine
	before := request(t, h, "GET", listPath, "", "")
	expectStatus(t, before, http.StatusOK)
	page := decode[store.Page](t, before)
	if page.UnreadCount != 1 || page.Total != 1 || strings.Contains(before.Body.String(), "contentHtml") {
		t.Fatalf("list: %s", before.Body.String())
	}
	read := request(t, h, "POST", path+"/read", `{"machineId":"`+strings.ToUpper(testMachine)+`"}`, "")
	expectStatus(t, read, http.StatusOK)
	after := request(t, h, "GET", listPath, "", "")
	page = decode[store.Page](t, after)
	if page.UnreadCount != 0 || !page.Items[0].IsRead {
		t.Fatalf("after: %+v", page)
	}
	other := request(t, h, "GET", "/api/v1/release-notes?machineId="+otherMachine, "", "")
	otherPage := decode[store.Page](t, other)
	if otherPage.UnreadCount != 1 || otherPage.Items[0].IsRead {
		t.Fatalf("other machine: %+v", otherPage)
	}
	if other.Header().Get("Cache-Control") != "no-store" {
		t.Fatal("machine state may be cached")
	}
}

func TestAdminAuthenticationAndDisabledMode(t *testing.T) {
	h := testHandler(t, adminToken)
	for _, token := range []string{"", "wrong"} {
		r := request(t, h, "POST", "/api/v1/admin/release-notes", `{"status":1}`, token)
		expectStatus(t, r, http.StatusUnauthorized)
		if r.Header().Get("WWW-Authenticate") != "Bearer" {
			t.Fatal("missing auth challenge")
		}
	}
	page := request(t, h, "GET", "/api/v1/admin/release-notes", "", adminToken)
	expectStatus(t, page, http.StatusOK)
	if decode[store.AdminPage](t, page).Total != 0 {
		t.Fatal("unauthorized request created a record")
	}
	disabled := testHandler(t, "")
	expectStatus(t, request(t, disabled, "GET", "/api/v1/admin/release-notes", "", adminToken), http.StatusServiceUnavailable)
	expectStatus(t, request(t, disabled, "GET", "/healthz", "", ""), http.StatusOK)
}

func TestDraftScheduledAndOfflineAreNotPublic(t *testing.T) {
	h := testHandler(t, adminToken)
	for _, state := range []struct {
		version     string
		status      int
		publishedAt any
	}{
		{"0.1.1", 0, nil}, {"0.1.2", 1, int64(4102444800000)}, {"0.1.3", 2, int64(1)},
	} {
		body, _ := json.Marshal(map[string]any{"version": state.version, "title": "test", "contentHtml": "<p>test</p>", "status": state.status, "publishedAt": state.publishedAt})
		created := request(t, h, "POST", "/api/v1/admin/release-notes", string(body), adminToken)
		expectStatus(t, created, http.StatusCreated)
		note := decode[store.Note](t, created)
		path := fmt.Sprintf("/api/v1/release-notes/%d", note.ID)
		expectStatus(t, request(t, h, "GET", path+"?machineId="+testMachine, "", ""), http.StatusNotFound)
		expectStatus(t, request(t, h, "POST", path+"/read", `{"machineId":"`+testMachine+`"}`, ""), http.StatusNotFound)
	}
	pageResponse := request(t, h, "GET", "/api/v1/release-notes?machineId="+testMachine, "", "")
	page := decode[store.Page](t, pageResponse)
	if page.Total != 0 || page.UnreadCount != 0 || page.Items == nil {
		t.Fatalf("empty page: %s", pageResponse.Body.String())
	}
}

func TestAdminEditConflictAndDelete(t *testing.T) {
	h := testHandler(t, adminToken)
	body := `{"version":"0.1.1","title":"first","contentHtml":"<p>first</p>","status":1}`
	created := request(t, h, "POST", "/api/v1/admin/release-notes", body, adminToken)
	expectStatus(t, created, http.StatusCreated)
	note := decode[store.Note](t, created)
	expectStatus(t, request(t, h, "POST", "/api/v1/admin/release-notes", body, adminToken), http.StatusConflict)
	path := fmt.Sprintf("/api/v1/admin/release-notes/%d", note.ID)
	updated := request(t, h, "PUT", path, `{"version":"0.1.1","title":"edited","contentHtml":"<p>edited</p>","status":2}`, adminToken)
	expectStatus(t, updated, http.StatusOK)
	if decode[store.Note](t, updated).Status != 2 {
		t.Fatal("offline edit was not saved")
	}
	expectStatus(t, request(t, h, "GET", path, "", adminToken), http.StatusOK)
	expectStatus(t, request(t, h, "DELETE", path, "", adminToken), http.StatusNoContent)
	expectStatus(t, request(t, h, "GET", path, "", adminToken), http.StatusNotFound)
}

func TestRejectMalformedRequests(t *testing.T) {
	h := testHandler(t, adminToken)
	cases := []struct {
		method, path, body, token string
		status                    int
	}{
		{"GET", "/api/v1/release-notes", "", "", 400},
		{"GET", "/api/v1/release-notes?machineId=00000000-0000-0000-0000-000000000000", "", "", 400},
		{"GET", "/api/v1/release-notes?machineId=" + testMachine + "&limit=101", "", "", 400},
		{"GET", "/api/v1/release-notes?machineId=" + testMachine + "&offset=-1", "", "", 400},
		{"GET", "/api/v1/release-notes/abc?machineId=" + testMachine, "", "", 400},
		{"GET", "/api/v1/release-notes/9223372036854775808?machineId=" + testMachine, "", "", 400},
		{"POST", "/api/v1/release-notes/1/read", `{"machineId":"` + testMachine + `","extra":1}`, "", 400},
		{"POST", "/api/v1/release-notes/1/read", `{"machineId":"` + testMachine + `"} {}`, "", 400},
		{"POST", "/api/v1/release-notes/1/read", `{"machineId":"` + strings.Repeat("a", 2048) + `"}`, "", 413},
		{"POST", "/api/v1/admin/release-notes", `{"version":"0.1.1","title":"test","status":1}`, adminToken, 400},
		{"POST", "/api/v1/admin/release-notes", `{"version":"0.1.1","title":"test"}`, adminToken, 400},
		{"POST", "/api/v1/admin/release-notes", `{"version":`, adminToken, 400},
		{"POST", "/api/v1/admin/release-notes", `null`, adminToken, 400},
	}
	for _, tc := range cases {
		t.Run(tc.method+tc.path+tc.body[:min(len(tc.body), 20)], func(t *testing.T) {
			expectStatus(t, request(t, h, tc.method, tc.path, tc.body, tc.token), tc.status)
		})
	}
	r := httptest.NewRequest("POST", "/api/v1/admin/release-notes", strings.NewReader(`{}`))
	r.Header.Set("Authorization", "Bearer "+adminToken)
	r.Header.Set("Content-Type", "text/plain")
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	expectStatus(t, w, http.StatusUnsupportedMediaType)
}
