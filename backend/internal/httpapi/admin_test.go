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

func TestAdminFeedbackRequiresAdminRole(t *testing.T) {
	_, db := fixture(t)
	mailer := &releaseNotesMail{}
	accounts, err := auth.New(db, mailer, strings.Repeat("fixture-secret-", 3))
	if err != nil {
		t.Fatal(err)
	}
	api := New(db, accounts, slog.New(slog.NewTextHandler(io.Discard, nil)), WithFeedback(db), WithAdmin(db))
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

	// /api/user/me reflects role changes without a new login.
	var me store.User
	if w := call("GET", "/api/user/me", "", admin); w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &me) != nil || me.Role != "USER" {
		t.Fatalf("me before promotion: %d %s", w.Code, w.Body.String())
	}
	if err := db.SetUserRole(t.Context(), adminID, "ADMIN"); err != nil {
		t.Fatal(err)
	}
	if w := call("GET", "/api/user/me", "", admin); w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &me) != nil || me.Role != "ADMIN" || me.Email != "admin@example.invalid" {
		t.Fatalf("me after promotion: %d %s", w.Code, w.Body.String())
	}
	if w := call("GET", "/api/user/me", "", ""); w.Code != 401 {
		t.Fatalf("anonymous me: %d", w.Code)
	}

	for _, body := range []string{
		`{"category":"bug","content":"界面卡住了","machineId":"f15f800e-0123-4123-8123-123456789abc"}`,
		`{"category":"feature","content":"希望支持导出"}`,
		`{"category":"bug","content":"100% 复现"}`,
	} {
		if w := call("POST", "/api/v1/feedback", body, user); w.Code != 201 {
			t.Fatalf("submit: %d %s", w.Code, w.Body.String())
		}
	}

	if w := call("GET", "/api/v1/admin/feedback", "", ""); w.Code != 401 {
		t.Fatalf("anonymous admin list: %d", w.Code)
	}
	if w := call("GET", "/api/v1/admin/feedback", "", user); w.Code != 403 {
		t.Fatalf("ordinary user admin list: %d", w.Code)
	}

	type page struct {
		Items        []store.AdminFeedback `json:"items"`
		Total        int                   `json:"total"`
		StatusCounts map[string]int        `json:"statusCounts"`
	}
	list := func(query string) page {
		t.Helper()
		w := call("GET", "/api/v1/admin/feedback"+query, "", admin)
		var result page
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("admin list %s: %d %s", query, w.Code, w.Body.String())
		}
		return result
	}
	all := list("")
	if all.Total != 3 || len(all.Items) != 3 || all.StatusCounts["0"] != 3 || all.StatusCounts["2"] != 0 {
		t.Fatalf("admin list: %+v", all)
	}
	newest := all.Items[0]
	if newest.User.Email != "user@example.invalid" || newest.User.PublicID == "" {
		t.Fatalf("submitter missing: %+v", newest.User)
	}
	oldest := all.Items[2]
	if oldest.MachineID == nil || *oldest.MachineID != "f15f800e-0123-4123-8123-123456789abc" {
		t.Fatalf("machine id missing for admin: %+v", oldest)
	}
	if got := list("?category=bug"); got.Total != 2 {
		t.Fatalf("category filter: %+v", got)
	}
	// % must be matched literally, not as a LIKE wildcard.
	if got := list("?q=" + "100%25"); got.Total != 1 || got.Items[0].Content != "100% 复现" {
		t.Fatalf("literal percent search: %+v", got)
	}
	if got := list("?q=USER@example"); got.Total != 3 {
		t.Fatalf("submitter email search: %+v", got)
	}

	path := "/api/v1/admin/feedback/" + strconv.FormatInt(newest.ID, 10)
	if w := call("PATCH", path, `{"status":2}`, user); w.Code != 403 {
		t.Fatalf("ordinary user update: %d", w.Code)
	}
	w := call("PATCH", path, `{"status":2,"adminNote":"  已在 0.1.243 修复  "}`, admin)
	var updated store.AdminFeedback
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &updated) != nil || updated.Status != 2 || updated.AdminNote == nil || *updated.AdminNote != "已在 0.1.243 修复" {
		t.Fatalf("update: %d %s", w.Code, w.Body.String())
	}
	if got := list("?status=2"); got.Total != 1 || got.StatusCounts["2"] != 1 || got.StatusCounts["0"] != 2 {
		t.Fatalf("status filter after update: %+v", got)
	}
	// Status-only updates keep the note; an empty note clears it.
	if w := call("PATCH", path, `{"status":1}`, admin); w.Code != 200 || !strings.Contains(w.Body.String(), "0.1.243") {
		t.Fatalf("status-only update dropped note: %s", w.Body.String())
	}
	if w := call("PATCH", path, `{"adminNote":""}`, admin); w.Code != 200 || !strings.Contains(w.Body.String(), `"adminNote":null`) {
		t.Fatalf("clearing note: %s", w.Body.String())
	}
	if w := call("GET", path, "", admin); w.Code != 200 {
		t.Fatalf("detail: %d", w.Code)
	}

	// The submitter sees the new status but never the internal fields.
	w = call("GET", "/api/v1/feedback", "", user)
	if w.Code != 200 || strings.Contains(w.Body.String(), "adminNote") || strings.Contains(w.Body.String(), "machineId") || !strings.Contains(w.Body.String(), `"status":1`) {
		t.Fatalf("submitter view: %s", w.Body.String())
	}

	for _, test := range []struct {
		method, path, body string
		status             int
	}{
		{"PATCH", path, `{}`, 400},
		{"PATCH", path, `{"status":9}`, 400},
		{"PATCH", path, `{"adminNote":"` + strings.Repeat("备", 2001) + `"}`, 400},
		{"PATCH", "/api/v1/admin/feedback/999999", `{"status":1}`, 404},
		{"GET", "/api/v1/admin/feedback/abc", "", 404},
		{"GET", "/api/v1/admin/feedback/007", "", 404},
		{"GET", "/api/v1/admin/feedback?status=7", "", 400},
		{"GET", "/api/v1/admin/feedback?category=praise", "", 400},
		{"GET", "/api/v1/admin/feedback?limit=0", "", 400},
	} {
		if w := call(test.method, test.path, test.body, admin); w.Code != test.status {
			t.Fatalf("%s %s: got %d want %d (%s)", test.method, test.path, w.Code, test.status, w.Body.String())
		}
	}
}
