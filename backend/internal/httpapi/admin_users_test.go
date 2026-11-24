package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/store"
)

type adminFixture struct {
	t        *testing.T
	db       *store.Store
	accounts *auth.Service
	mailer   *releaseNotesMail
	call     func(method, path, body, token string) *httptest.ResponseRecorder
}

func newAdminFixture(t *testing.T) *adminFixture {
	t.Helper()
	_, db := fixture(t)
	mailer := &releaseNotesMail{}
	accounts, err := auth.New(db, mailer, strings.Repeat("fixture-secret-", 3))
	if err != nil {
		t.Fatal(err)
	}
	api := New(db, accounts, slog.New(slog.NewTextHandler(io.Discard, nil)), WithReleaseNotes(db, ""), WithFeedback(db), WithAdmin(db))
	t.Cleanup(api.Shutdown)
	h := api.Handler()
	call := func(method, path, body, token string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", "application/json")
		// Distinct addresses keep the per-IP login limits out of the way.
		r.RemoteAddr = "192.0.2." + strconv.Itoa(len(path)%200+1) + ":1234"
		if token != "" {
			r.Header.Set("Authorization", "Bearer "+token)
		}
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	return &adminFixture{t: t, db: db, accounts: accounts, mailer: mailer, call: call}
}

func (f *adminFixture) login(email string) (string, int64) {
	f.t.Helper()
	if w := f.call("POST", "/api/user/login/code", `{"email":"`+email+`"}`, ""); w.Code != 204 {
		f.t.Fatalf("login code: %d %s", w.Code, w.Body.String())
	}
	w := f.call("POST", "/api/user/login", `{"email":"`+email+`","code":"`+f.mailer.code+`"}`, "")
	var response auth.LoginResponse
	if err := json.Unmarshal(w.Body.Bytes(), &response); err != nil || w.Code != 200 {
		f.t.Fatalf("login: %d %s", w.Code, w.Body.String())
	}
	id, err := f.accounts.Introspect(f.t.Context(), "Bearer "+response.AccessToken)
	if err != nil {
		f.t.Fatal(err)
	}
	return response.AccessToken, id
}

func (f *adminFixture) user(token, publicID string) (store.AdminUserDetail, []string) {
	f.t.Helper()
	w := f.call("GET", "/api/v1/admin/users/"+publicID, "", token)
	var body struct {
		User   store.AdminUserDetail `json:"user"`
		Online []string              `json:"onlineDeviceIds"`
	}
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &body) != nil {
		f.t.Fatalf("user detail: %d %s", w.Code, w.Body.String())
	}
	return body.User, body.Online
}

func TestAdminUserManagementAndRevocation(t *testing.T) {
	f := newAdminFixture(t)
	admin, adminID := f.login("admin@example.invalid")
	member, _ := f.login("member@example.invalid")
	second, secondID := f.login("second@example.invalid")
	third, _ := f.login("third@example.invalid")
	if err := f.db.SetUserRole(t.Context(), adminID, "ADMIN"); err != nil {
		t.Fatal(err)
	}
	publicID := func(token string) string {
		var me store.User
		if err := json.Unmarshal(f.call("GET", "/api/user/me", "", token).Body.Bytes(), &me); err != nil || me.PublicID == "" {
			t.Fatalf("me: %v", err)
		}
		return me.PublicID
	}
	memberPublic, adminPublic, secondPublic, thirdPublic := publicID(member), publicID(admin), publicID(second), publicID(third)

	if w := f.call("GET", "/api/v1/admin/users", "", member); w.Code != 403 {
		t.Fatalf("ordinary list: %d", w.Code)
	}
	if w := f.call("POST", "/api/v1/feedback", `{"category":"bug","content":"x"}`, member); w.Code != 201 {
		t.Fatalf("feedback: %d", w.Code)
	}

	type page struct {
		Items []store.AdminUser `json:"items"`
		Total int               `json:"total"`
	}
	list := func(query string) page {
		t.Helper()
		var result page
		w := f.call("GET", "/api/v1/admin/users"+query, "", admin)
		if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &result) != nil {
			t.Fatalf("list %s: %d %s", query, w.Code, w.Body.String())
		}
		return result
	}
	all := list("")
	if all.Total != 4 || all.Items[0].Email != "third@example.invalid" || all.Items[2].Email != "member@example.invalid" ||
		all.Items[2].FeedbackCount != 1 || all.Items[2].LastLoginAt == nil || all.Items[2].CreatedAt == 0 {
		t.Fatalf("all users: %+v", all)
	}
	if strings.Contains(f.call("GET", "/api/v1/admin/users", "", admin).Body.String(), "tokenVersion") {
		t.Fatal("token version leaked")
	}
	if got := list("?q=MEMBER@"); got.Total != 1 {
		t.Fatalf("search: %+v", got)
	}
	if got := list("?role=ADMIN"); got.Total != 1 || got.Items[0].Email != "admin@example.invalid" {
		t.Fatalf("role filter: %+v", got)
	}
	for _, query := range []string{"?role=ROOT", "?enabled=maybe", "?limit=0"} {
		if w := f.call("GET", "/api/v1/admin/users"+query, "", admin); w.Code != 400 {
			t.Fatalf("bad query %s: %d", query, w.Code)
		}
	}
	if w := f.call("GET", "/api/v1/admin/users/usr_missing", "", admin); w.Code != 404 {
		t.Fatalf("missing user: %d", w.Code)
	}

	// Self-protection and last-admin protection.
	if w := f.call("PATCH", "/api/v1/admin/users/"+adminPublic, `{"enabled":false}`, admin); w.Code != 409 || !strings.Contains(w.Body.String(), "SELF_CHANGE_FORBIDDEN") {
		t.Fatalf("self disable: %d %s", w.Code, w.Body.String())
	}
	if w := f.call("PATCH", "/api/v1/admin/users/"+adminPublic, `{"role":"USER"}`, admin); w.Code != 409 {
		t.Fatalf("self demote: %d", w.Code)
	}
	if w := f.call("PATCH", "/api/v1/admin/users/"+memberPublic, `{"role":"GOD"}`, admin); w.Code != 400 {
		t.Fatalf("bad role: %d", w.Code)
	}

	// Disable: the member's existing token stops working immediately.
	w := f.call("PATCH", "/api/v1/admin/users/"+memberPublic, `{"enabled":false}`, admin)
	var updated store.AdminUser
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &updated) != nil || updated.Enabled {
		t.Fatalf("disable: %d %s", w.Code, w.Body.String())
	}
	if w := f.call("GET", "/api/v1/feedback", "", member); w.Code != 401 {
		t.Fatalf("disabled member still authorised: %d", w.Code)
	}
	if got := list("?enabled=0"); got.Total != 1 {
		t.Fatalf("disabled filter: %+v", got)
	}
	// Re-enabling does not resurrect the old token (disable bumped token_version).
	if w := f.call("PATCH", "/api/v1/admin/users/"+memberPublic, `{"enabled":true}`, admin); w.Code != 200 {
		t.Fatalf("enable: %d", w.Code)
	}
	if w := f.call("GET", "/api/v1/feedback", "", member); w.Code != 401 {
		t.Fatalf("old token resurrected after re-enable: %d", w.Code)
	}
	detail, online := f.user(admin, memberPublic)
	if !detail.Enabled || len(online) != 0 || len(detail.RecentFeedback) != 1 || len(detail.Audit) != 2 ||
		detail.Audit[0].ActorEmail != "admin@example.invalid" || !strings.Contains(string(detail.Audit[1].Detail), `"enabled"`) {
		t.Fatalf("detail/audit: %+v", detail)
	}

	// With a second admin, one admin may demote the other; the demoted one loses access at once.
	if w := f.call("PATCH", "/api/v1/admin/users/"+secondPublic, `{"role":"ADMIN"}`, admin); w.Code != 200 {
		t.Fatalf("promote: %d", w.Code)
	}
	if w := f.call("PATCH", "/api/v1/admin/users/"+adminPublic, `{"role":"USER"}`, second); w.Code != 200 {
		t.Fatalf("demote other admin: %d %s", w.Code, w.Body.String())
	}
	if w := f.call("GET", "/api/v1/admin/users", "", admin); w.Code != 403 {
		t.Fatalf("demoted admin still has access: %d", w.Code)
	}
	// second is now the only admin and cannot lose that role.
	if err := f.db.SetUserRole(t.Context(), adminID, "ADMIN"); err != nil {
		t.Fatal(err)
	}
	if err := f.db.SetUserRole(t.Context(), secondID, "USER"); err != nil {
		t.Fatal(err)
	}

	// Revoke sessions: the token stops working and an audit entry is recorded.
	if w := f.call("GET", "/api/v1/feedback", "", third); w.Code != 200 {
		t.Fatalf("third before revoke: %d", w.Code)
	}
	w = f.call("POST", "/api/v1/admin/users/"+thirdPublic+"/revoke-sessions", "", admin)
	if w.Code != 200 || !strings.Contains(w.Body.String(), `"self":false`) {
		t.Fatalf("revoke: %d %s", w.Code, w.Body.String())
	}
	if w := f.call("GET", "/api/v1/feedback", "", third); w.Code != 401 {
		t.Fatalf("revoked token still works: %d", w.Code)
	}
	if detail, _ := f.user(admin, thirdPublic); len(detail.Audit) != 1 || detail.Audit[0].Action != "user.revoke_sessions" {
		t.Fatalf("revoke audit: %+v", detail.Audit)
	}
}

func TestAdminLastAdminIsProtected(t *testing.T) {
	f := newAdminFixture(t)
	admin, adminID := f.login("admin@example.invalid")
	other, otherID := f.login("other@example.invalid")
	for _, id := range []int64{adminID, otherID} {
		if err := f.db.SetUserRole(t.Context(), id, "ADMIN"); err != nil {
			t.Fatal(err)
		}
	}
	var me store.User
	json.Unmarshal(f.call("GET", "/api/user/me", "", other).Body.Bytes(), &me)
	// Disabling the other admin is allowed while admin remains...
	if w := f.call("PATCH", "/api/v1/admin/users/"+me.PublicID, `{"enabled":false}`, admin); w.Code != 200 {
		t.Fatalf("disable other admin: %d %s", w.Code, w.Body.String())
	}
	// ...but the remaining admin is now the last one; flipping it via the store (as another actor) is refused.
	json.Unmarshal(f.call("GET", "/api/user/me", "", admin).Body.Bytes(), &me)
	role := "USER"
	if _, err := f.db.UpdateAdminUser(t.Context(), otherID, me.PublicID, store.AdminUserUpdate{Role: &role}, 1); err != store.ErrLastAdmin {
		t.Fatalf("last admin demoted: %v", err)
	}
}

func TestAdminStatsAndMachines(t *testing.T) {
	f := newAdminFixture(t)
	admin, adminID := f.login("admin@example.invalid")
	member, _ := f.login("member@example.invalid")
	if err := f.db.SetUserRole(t.Context(), adminID, "ADMIN"); err != nil {
		t.Fatal(err)
	}
	if w := f.call("GET", "/api/v1/admin/stats", "", member); w.Code != 403 {
		t.Fatalf("ordinary stats: %d", w.Code)
	}
	if w := f.call("POST", "/api/v1/feedback", `{"category":"bug","content":"x","machineId":"aaaaaaaa-0123-4123-8123-123456789abc"}`, member); w.Code != 201 {
		t.Fatalf("feedback: %d", w.Code)
	}
	var notes []store.Note
	now := time.Now().UnixMilli()
	published := strconv.FormatInt(now-60*24*60*60*1000, 10)
	for _, version := range []string{"0.1.1", "0.1.2"} {
		w := f.call("POST", "/api/v1/admin/release-notes", `{"version":"`+version+`","title":"t","contentHtml":"<p>x</p>","status":1,"publishedAt":`+published+`}`, admin)
		var note store.Note
		if w.Code != 201 || json.Unmarshal(w.Body.Bytes(), &note) != nil {
			t.Fatalf("note: %d %s", w.Code, w.Body.String())
		}
		notes = append(notes, note)
	}
	if w := f.call("POST", "/api/v1/admin/release-notes", `{"version":"0.1.3","title":"draft","contentHtml":"","status":0}`, admin); w.Code != 201 {
		t.Fatalf("draft: %d", w.Code)
	}
	machines := []string{"aaaaaaaa-0123-4123-8123-123456789abc", "bbbbbbbb-0123-4123-8123-123456789abc"}
	// Machine A read both notes; machine B only the first, 40 days ago.
	if _, err := f.db.MarkReleaseNoteRead(t.Context(), notes[0].ID, machines[0], now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.MarkReleaseNoteRead(t.Context(), notes[1].ID, machines[0], now); err != nil {
		t.Fatal(err)
	}
	if _, err := f.db.MarkReleaseNoteRead(t.Context(), notes[0].ID, machines[1], now-40*24*60*60*1000); err != nil {
		t.Fatal(err)
	}

	var stats store.AdminStats
	w := f.call("GET", "/api/v1/admin/stats", "", admin)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &stats) != nil {
		t.Fatalf("stats: %d %s", w.Code, w.Body.String())
	}
	if stats.Users.Total != 2 || stats.Users.New7d != 2 || stats.Users.Active7d != 2 || stats.Users.Admins != 1 ||
		stats.Feedback.Pending != 1 || stats.Feedback.New7d != 1 ||
		stats.ReleaseNotes.Published != 2 || stats.ReleaseNotes.Drafts != 1 ||
		stats.Machines.Total != 2 || stats.Machines.Read7d != 1 || stats.Machines.Read30d != 1 ||
		len(stats.Machines.DailyNew) != 30 || stats.Machines.DailyNew[29].Count != 1 || len(stats.Machines.NoteReach) != 2 {
		t.Fatalf("stats: %+v", stats)
	}
	reach := map[int64]int{}
	for _, item := range stats.Machines.NoteReach {
		reach[item.ID] = item.ReadCount
	}
	if reach[notes[0].ID] != 2 || reach[notes[1].ID] != 1 {
		t.Fatalf("note reach: %+v", stats.Machines.NoteReach)
	}

	var machinePage struct {
		Items []store.Machine `json:"items"`
		Total int             `json:"total"`
	}
	w = f.call("GET", "/api/v1/admin/machines", "", admin)
	if w.Code != 200 || json.Unmarshal(w.Body.Bytes(), &machinePage) != nil || machinePage.Total != 2 ||
		machinePage.Items[0].MachineID != machines[0] || machinePage.Items[0].ReadCount != 2 || machinePage.Items[0].FeedbackCount != 1 {
		t.Fatalf("machines: %d %s", w.Code, w.Body.String())
	}
	w = f.call("GET", "/api/v1/admin/machines?q=BBBB", "", admin)
	if json.Unmarshal(w.Body.Bytes(), &machinePage) != nil || machinePage.Total != 1 || machinePage.Items[0].MachineID != machines[1] {
		t.Fatalf("machine search: %s", w.Body.String())
	}
	if w := f.call("GET", "/api/v1/admin/machines?q=%25", "", admin); w.Code != 400 {
		t.Fatalf("machine wildcard query accepted: %d", w.Code)
	}

	var notePage store.AdminPage
	w = f.call("GET", "/api/v1/admin/release-notes?status=1", "", admin)
	if json.Unmarshal(w.Body.Bytes(), &notePage) != nil || notePage.MachineCount != 2 || len(notePage.Items) != 2 || notePage.Items[0].ReadCount == nil {
		t.Fatalf("release note reach in admin list: %s", w.Body.String())
	}
}
