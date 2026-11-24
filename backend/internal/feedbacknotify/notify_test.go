package feedbacknotify

import (
	"context"
	"errors"
	"strings"
	"testing"

	"web2term/backend/internal/store"
)

type fakeStore struct {
	admins []string
	user   store.User
	err    error
}

func (f fakeStore) AdminEmails(context.Context) ([]string, error) { return f.admins, f.err }
func (f fakeStore) UserByID(_ context.Context, id int64) (store.User, error) {
	if id != f.user.ID {
		return store.User{}, errors.New("unknown user")
	}
	return f.user, nil
}

type sent struct{ to, subject, body string }
type fakeSender struct {
	messages []sent
	fail     map[string]bool
}

func (f *fakeSender) Send(_ context.Context, to, subject, body string) error {
	f.messages = append(f.messages, sent{to, subject, body})
	if f.fail[to] {
		return errors.New("synthetic delivery failure")
	}
	return nil
}

var item = store.Feedback{ID: 12, Category: "bug", Content: "第一行\n第二行", Email: "owner@example.invalid",
	AppVersion: "0.1.243", Platform: "win32-x64", CreatedAt: 1795487879494}

func TestNotifySendsOneMessagePerAdministrator(t *testing.T) {
	sender := &fakeSender{}
	user := store.User{ID: 7, Email: "owner@example.invalid", Nickname: "小王"}
	n := New(fakeStore{admins: []string{"a@example.invalid", "b@example.invalid"}, user: user}, sender)
	admins, err := n.Notify(t.Context(), 7, item)
	if err != nil || admins != 2 || len(sender.messages) != 2 {
		t.Fatalf("notify: %d %v %+v", admins, err, sender.messages)
	}
	if sender.messages[0].to != "a@example.invalid" || sender.messages[1].to != "b@example.invalid" {
		t.Fatalf("recipients: %+v", sender.messages)
	}
	m := sender.messages[0]
	if m.subject != "Web2Term 新反馈 #12：Bug / 问题" {
		t.Fatalf("subject: %q", m.subject)
	}
	for _, want := range []string{"编号：#12", "类型：Bug / 问题", "提交账号：owner@example.invalid（小王）", "客户端：v0.1.243 · win32-x64",
		"提交时间：2026-11-24 10:37:59（UTC+8）", "第一行\n第二行"} {
		if !strings.Contains(m.body, want) {
			t.Fatalf("body lacks %q:\n%s", want, m.body)
		}
	}
	if strings.Contains(m.body, "联系邮箱") {
		t.Fatalf("contact email equal to the account email should be omitted:\n%s", m.body)
	}
}

func TestNotifyShowsADifferentContactEmailAndReportsPartialFailure(t *testing.T) {
	sender := &fakeSender{fail: map[string]bool{"a@example.invalid": true}}
	user := store.User{ID: 7, Email: "owner@example.invalid"}
	contact := item
	contact.Email = "contact@example.invalid"
	admins, err := New(fakeStore{admins: []string{"a@example.invalid", "b@example.invalid"}, user: user}, sender).Notify(t.Context(), 7, contact)
	if err == nil || admins != 2 || len(sender.messages) != 2 {
		t.Fatalf("partial failure must still try every admin: %d %v %d", admins, err, len(sender.messages))
	}
	if !strings.Contains(sender.messages[1].body, "联系邮箱：contact@example.invalid") {
		t.Fatalf("contact email missing:\n%s", sender.messages[1].body)
	}
}

func TestNotifyWithoutAdministratorsSendsNothing(t *testing.T) {
	sender := &fakeSender{}
	if admins, err := New(fakeStore{}, sender).Notify(t.Context(), 7, item); admins != 0 || err != nil || len(sender.messages) != 0 {
		t.Fatalf("no admins: %d %v %d", admins, err, len(sender.messages))
	}
	lookup := errors.New("synthetic lookup failure")
	if _, err := New(fakeStore{err: lookup}, sender).Notify(t.Context(), 7, item); !errors.Is(err, lookup) || len(sender.messages) != 0 {
		t.Fatalf("lookup failure: %v %d", err, len(sender.messages))
	}
}
