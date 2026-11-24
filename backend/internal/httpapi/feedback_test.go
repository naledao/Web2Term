package httpapi

import (
	"encoding/json"
	"io"
	"log/slog"
	"net/http/httptest"
	"strings"
	"testing"

	"web2term/backend/internal/auth"
	"web2term/backend/internal/store"
)

func TestFeedbackRequiresLoginAndListsOnlyOwnItems(t *testing.T) {
	_, db := fixture(t)
	mailer := &releaseNotesMail{}
	accounts, err := auth.New(db, mailer, strings.Repeat("fixture-secret-", 3))
	if err != nil {
		t.Fatal(err)
	}
	api := New(db, accounts, slog.New(slog.NewTextHandler(io.Discard, nil)), WithFeedback(db))
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

	valid := `{"machineId":"F15F800E-0123-4123-8123-123456789ABC","category":"bug","content":"  第一行\r\n第二行  ","email":"","appVersion":"0.1.242","platform":"win32-x64"}`
	if w := call("POST", "/api/v1/feedback", valid, ""); w.Code != 401 {
		t.Fatalf("anonymous submit: %d", w.Code)
	}
	if w := call("GET", "/api/v1/feedback", "", ""); w.Code != 401 {
		t.Fatalf("anonymous list: %d", w.Code)
	}

	owner := login("owner@example.invalid")
	w := call("POST", "/api/v1/feedback", valid, owner)
	var created store.Feedback
	if err := json.Unmarshal(w.Body.Bytes(), &created); err != nil || w.Code != 201 {
		t.Fatalf("submit: %d %s", w.Code, w.Body.String())
	}
	if created.Content != "第一行\n第二行" || created.Email != "owner@example.invalid" || created.Category != "bug" || created.Status != 0 || created.ID <= 0 {
		t.Fatalf("unexpected created feedback: %+v", created)
	}
	if strings.Contains(w.Body.String(), "adminNote") || strings.Contains(w.Body.String(), "machine") {
		t.Fatalf("internal fields leaked: %s", w.Body.String())
	}

	for _, body := range []string{
		`{"category":"praise","content":"x"}`,
		`{"category":"bug","content":"   "}`,
		`{"category":"bug","content":"` + strings.Repeat("长", 5001) + `"}`,
		`{"category":"bug","content":"x","email":"not-an-email"}`,
		`{"category":"bug","content":"x","machineId":"nope"}`,
		`{"category":"bug","content":"x","platform":"` + strings.Repeat("p", 65) + `"}`,
		`{"category":"bug","content":"bad\u0000byte"}`,
	} {
		if w := call("POST", "/api/v1/feedback", body, owner); w.Code != 400 {
			t.Fatalf("invalid body accepted (%d): %.80s", w.Code, body)
		}
	}
	// 5000 CJK characters are about 15 KB of UTF-8 and must fit the request limit.
	long := `{"category":"feature","content":"` + strings.Repeat("长", 5000) + `"}`
	if w := call("POST", "/api/v1/feedback", long, owner); w.Code != 201 {
		t.Fatalf("maximum length rejected: %d %s", w.Code, w.Body.String())
	}

	other := login("other@example.invalid")
	if w := call("POST", "/api/v1/feedback", `{"category":"other","content":"别人的反馈"}`, other); w.Code != 201 {
		t.Fatalf("other submit: %d", w.Code)
	}
	w = call("GET", "/api/v1/feedback?limit=10", "", owner)
	var page struct {
		Items  []store.Feedback `json:"items"`
		Total  int              `json:"total"`
		Limit  int              `json:"limit"`
		Offset int              `json:"offset"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &page); err != nil || w.Code != 200 {
		t.Fatalf("list: %d %s", w.Code, w.Body.String())
	}
	if page.Total != 2 || len(page.Items) != 2 || page.Limit != 10 || page.Offset != 0 || page.Items[1].ID != created.ID {
		t.Fatalf("owner page: %+v", page)
	}
	for _, item := range page.Items {
		if item.Content == "别人的反馈" {
			t.Fatal("another user's feedback leaked into the list")
		}
	}
	for _, query := range []string{"?limit=0", "?limit=101", "?offset=-1", "?limit=abc"} {
		if w := call("GET", "/api/v1/feedback"+query, "", owner); w.Code != 400 {
			t.Fatalf("bad pagination %s: %d", query, w.Code)
		}
	}
}
