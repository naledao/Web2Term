package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/store"
)

func TestReleaseNotesAdministrationByAdminAccount(t *testing.T) {
	for _, staticToken := range []string{"", "fixture-release-admin"} {
		t.Run("token="+strconv.FormatBool(staticToken != ""), func(t *testing.T) {
			_, db := fixture(t)
			mailer := &releaseNotesMail{}
			accounts, err := auth.New(db, mailer, strings.Repeat("fixture-secret-", 3))
			if err != nil {
				t.Fatal(err)
			}
			api := New(db, accounts, slog.New(slog.NewTextHandler(io.Discard, nil)), WithReleaseNotes(db, staticToken), WithAdmin(db))
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
			login := func(email string) string {
				if w := call("POST", "/api/user/login/code", `{"email":"`+email+`"}`, ""); w.Code != 204 {
					t.Fatalf("login code: %d %s", w.Code, w.Body.String())
				}
				w := call("POST", "/api/user/login", `{"email":"`+email+`","code":"`+mailer.code+`"}`, "")
				var response auth.LoginResponse
				if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 {
					t.Fatalf("login: %d %s", w.Code, w.Body.String())
				}
				return response.AccessToken
			}
			user := login("user@example.invalid")
			admin := login("admin@example.invalid")
			adminID, err := accounts.Introspect(t.Context(), "Bearer "+admin)
			if err != nil {
				t.Fatal(err)
			}

			draft := `{"version":"v0.1.300","title":"草稿","contentHtml":"","status":0}`
			if w := call("POST", "/api/v1/admin/release-notes", draft, ""); w.Code != 401 {
				t.Fatalf("anonymous create: %d", w.Code)
			}
			if w := call("POST", "/api/v1/admin/release-notes", draft, admin); w.Code != 403 {
				t.Fatalf("admin account before promotion: %d %s", w.Code, w.Body.String())
			}
			if err := db.SetUserRole(t.Context(), adminID, "ADMIN"); err != nil {
				t.Fatal(err)
			}
			if w := call("GET", "/api/v1/admin/release-notes", "", user); w.Code != 403 || !strings.Contains(w.Body.String(), "ADMIN_REQUIRED") {
				t.Fatalf("ordinary account list: %d %s", w.Code, w.Body.String())
			}

			w := call("POST", "/api/v1/admin/release-notes", draft, admin)
			var created store.Note
			if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &created) != nil || created.Version != "0.1.300" || created.Status != store.Draft {
				t.Fatalf("admin create: %d %s", w.Code, w.Body.String())
			}
			published := `{"version":"0.1.301","title":"已发布","contentHtml":"<p>内容</p>","status":1}`
			if w := call("POST", "/api/v1/admin/release-notes", published, admin); w.Code != 201 {
				t.Fatalf("admin publish: %d %s", w.Code, w.Body.String())
			}
			if w := call("POST", "/api/v1/admin/release-notes", published, admin); w.Code != 409 {
				t.Fatalf("duplicate version: %d", w.Code)
			}

			var page store.AdminPage
			list := func(query string) store.AdminPage {
				t.Helper()
				w := call("GET", "/api/v1/admin/release-notes"+query, "", admin)
				page = store.AdminPage{}
				if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &page) != nil {
					t.Fatalf("list %s: %d %s", query, w.Code, w.Body.String())
				}
				return page
			}
			if got := list(""); got.Total != 2 {
				t.Fatalf("all notes: %+v", got)
			}
			if got := list("?status=0"); got.Total != 1 || got.Items[0].ID != created.ID {
				t.Fatalf("draft filter: %+v", got)
			}
			if got := list("?status=1"); got.Total != 1 || got.Items[0].Version != "0.1.301" {
				t.Fatalf("published filter: %+v", got)
			}
			if got := list("?status=2"); got.Total != 0 || len(got.Items) != 0 {
				t.Fatalf("offline filter: %+v", got)
			}
			for _, query := range []string{"?status=3", "?status=-1", "?status=x"} {
				if w := call("GET", "/api/v1/admin/release-notes"+query, "", admin); w.Code != 400 {
					t.Fatalf("bad status %s: %d", query, w.Code)
				}
			}

			path := "/api/v1/admin/release-notes/" + strconv.FormatInt(created.ID, 10)
			if w := call("PUT", path, `{"version":"0.1.300","title":"发布草稿","contentHtml":"<p>正文</p>","status":1}`, admin); w.Code != 200 {
				t.Fatalf("admin update: %d %s", w.Code, w.Body.String())
			}
			if w := call("GET", path, "", admin); w.Code != 200 || !strings.Contains(w.Body.String(), "正文") {
				t.Fatalf("admin detail: %d %s", w.Code, w.Body.String())
			}
			if w := call("DELETE", path, "", user); w.Code != 403 {
				t.Fatalf("ordinary delete: %d", w.Code)
			}
			if w := call("DELETE", path, "", admin); w.Code != 204 {
				t.Fatalf("admin delete: %d", w.Code)
			}

			// The static token keeps working for MCP when it is configured.
			if staticToken != "" {
				if w := call("GET", "/api/v1/admin/release-notes", "", staticToken); w.Code != 200 {
					t.Fatalf("static token: %d", w.Code)
				}
			}
			if w := call("GET", "/api/v1/admin/release-notes", "", "wrong-token"); w.Code != 401 {
				t.Fatalf("wrong token: %d", w.Code)
			}
		})
	}
}
