package httpapi

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/store"
)

type releaseNotesMail struct{ code string }

func (m *releaseNotesMail) SendCode(_ context.Context, _, code string) error {
	m.code = code
	return nil
}

func TestReleaseNotesSharesBackendAuthenticationAndListener(t *testing.T) {
	_, db := fixture(t)
	mailer := &releaseNotesMail{}
	accounts, err := auth.New(db, mailer, strings.Repeat("fixture-secret-", 3))
	if err != nil {
		t.Fatal(err)
	}
	const admin = "fixture-release-admin"
	api := New(db, accounts, slog.New(slog.NewTextHandler(io.Discard, nil)), WithReleaseNotes(db, admin))
	defer api.Shutdown()
	h := api.Handler()
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := call("POST", "/api/user/login/code", `{"email":"fixture@example.invalid"}`, ""); w.Code != 204 {
		t.Fatalf("login code: %d %s", w.Code, w.Body.String())
	}
	w := call("POST", "/api/user/login", `{"email":"fixture@example.invalid","code":"`+mailer.code+`"}`, "")
	var login auth.LoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &login); err != nil || w.Code != 200 || login.AccessToken == "" {
		t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	if w := call("GET", "/api/user/devices", "", login.AccessToken); w.Code != 200 {
		t.Fatalf("device route: %d", w.Code)
	}
	body := `{"version":"0.1.200","title":"更新","contentHtml":"<article>完整 HTML</article>","status":1}`
	if w := call("POST", "/api/v1/admin/release-notes", body, login.AccessToken); w.Code != 401 {
		t.Fatalf("ordinary login granted release administration: %d", w.Code)
	}
	w = call("POST", "/api/v1/admin/release-notes", body, admin)
	var note store.Note
	if err := json.Unmarshal(w.Body.Bytes(), &note); err != nil || w.Code != 201 || note.ID <= 0 {
		t.Fatalf("create: %d %s", w.Code, w.Body.String())
	}
	const machine = "f15f800e-0123-4123-8123-123456789abc"
	w = call("GET", "/api/v1/release-notes?machineId="+machine, "", "")
	var page store.Page
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != 200 || page.Total != 1 || page.UnreadCount != 1 {
		t.Fatalf("public list: %d %s", w.Code, w.Body.String())
	}
	path := "/api/v1/release-notes/" + strconv.FormatInt(note.ID, 10)
	if w := call("POST", path+"/read", `{"machineId":"`+machine+`"}`, ""); w.Code != 200 {
		t.Fatalf("read: %d %s", w.Code, w.Body.String())
	}
	detail, err := db.GetReleaseNote(t.Context(), note.ID, machine, note.CreatedAt+1000)
	if err != nil || !detail.IsRead || detail.ContentHTML != "<article>完整 HTML</article>" {
		t.Fatalf("read state was not saved in the backend store: %+v %v", detail, err)
	}
	if w := call("GET", "/healthz", "", ""); w.Code != http.StatusOK {
		t.Fatalf("shared health route: %d", w.Code)
	}
}

func TestReleaseNotesPublicRoutesRemainAvailableWithoutAdminToken(t *testing.T) {
	_, db := fixture(t)
	api := New(db, fixtureUsers{}, slog.Default(), WithReleaseNotes(db, ""))
	defer api.Shutdown()
	h := api.Handler()
	w := request(t, h, "GET", "/api/v1/release-notes?machineId=f15f800e-0123-4123-8123-123456789abc", "", "")
	if w.Code != 200 {
		t.Fatalf("public list: %d %s", w.Code, w.Body.String())
	}
	w = request(t, h, "GET", "/api/v1/admin/release-notes", "", "Bearer owner")
	if w.Code != 503 || !strings.Contains(w.Body.String(), "ADMIN_DISABLED") {
		t.Fatalf("disabled admin: %d %s", w.Code, w.Body.String())
	}
}
