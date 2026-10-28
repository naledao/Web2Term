package store

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"sync"
	"testing"
)

const machineA = "f15f800e-0123-4123-8123-123456789abc"
const machineB = "f15f800e-0123-4123-8123-123456789abd"

func pointer[T any](value T) *T { return &value }

func openReleaseNotesTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(t.Context(), filepath.Join(t.TempDir(), "with space #", "notes.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func input(version string, status int, publishedAt *int64) NoteInput {
	return NoteInput{Version: version, Title: "版本更新说明", ContentHTML: "<article><h3>新增</h3><p>示例内容</p></article>",
		Status: pointer(status), PublishedAt: publishedAt}
}

func create(t *testing.T, s *Store, in NoteInput, now int64) Note {
	t.Helper()
	note, err := s.CreateReleaseNote(t.Context(), in, now)
	if err != nil {
		t.Fatal(err)
	}
	return note
}

func TestPublicationFilteringPaginationAndMachineIsolation(t *testing.T) {
	s := openReleaseNotesTestStore(t)
	first := create(t, s, input("0.1.1", Published, pointer(int64(100))), 100)
	second := create(t, s, input("0.1.2", Published, pointer(int64(200))), 200)
	third := create(t, s, input("0.1.3", Published, pointer(int64(300))), 300)
	draft := create(t, s, input("0.1.4", Draft, nil), 400)
	future := create(t, s, input("0.1.5", Published, pointer(int64(2000))), 500)
	offline := create(t, s, input("0.1.6", Offline, pointer(int64(600))), 600)
	if _, err := s.MarkReleaseNoteRead(t.Context(), first.ID, machineA, 800); err != nil {
		t.Fatal(err)
	}
	page, err := s.ListReleaseNotes(t.Context(), machineA, 1000, 1, 1)
	if err != nil {
		t.Fatal(err)
	}
	if page.Total != 3 || page.UnreadCount != 2 || len(page.Items) != 1 || page.Items[0].ID != second.ID {
		t.Fatalf("unexpected page: %+v", page)
	}
	other, err := s.ListReleaseNotes(t.Context(), machineB, 1000, 20, 0)
	if err != nil {
		t.Fatal(err)
	}
	if other.Total != 3 || other.UnreadCount != 3 || other.Items[0].ID != third.ID {
		t.Fatalf("other machine: %+v", other)
	}
	for _, id := range []int64{draft.ID, future.ID, offline.ID, 9999} {
		if _, err := s.GetReleaseNote(t.Context(), id, machineA, 1000); !errors.Is(err, ErrNotFound) {
			t.Fatalf("detail %d: %v", id, err)
		}
		if _, err := s.MarkReleaseNoteRead(t.Context(), id, machineA, 1000); !errors.Is(err, ErrNotFound) {
			t.Fatalf("read %d: %v", id, err)
		}
	}
	for _, id := range []int64{draft.ID, future.ID, offline.ID} {
		if _, err := s.GetAdminReleaseNote(t.Context(), id); err != nil {
			t.Fatal(err)
		}
	}
	admin, err := s.ListAdminReleaseNotes(t.Context(), 20, 0)
	if err != nil || admin.Total != 6 {
		t.Fatalf("admin page: %+v, %v", admin, err)
	}
}

func TestDetailDoesNotMarkReadAndRepeatedReadIsMonotonic(t *testing.T) {
	s := openReleaseNotesTestStore(t)
	note := create(t, s, input("0.1.1", Published, nil), 100)
	detail, err := s.GetReleaseNote(t.Context(), note.ID, machineA, 200)
	if err != nil {
		t.Fatal(err)
	}
	if detail.IsRead || detail.ReadAt != nil || detail.ContentHTML != note.ContentHTML {
		t.Fatalf("detail: %+v", detail)
	}
	for _, now := range []int64{300, 400, 350} {
		if _, err := s.MarkReleaseNoteRead(t.Context(), note.ID, machineA, now); err != nil {
			t.Fatal(err)
		}
	}
	detail, err = s.GetReleaseNote(t.Context(), note.ID, machineA, 500)
	if err != nil || !detail.IsRead || detail.ReadAt == nil || *detail.ReadAt != 400 {
		t.Fatalf("read state: %+v %v", detail, err)
	}
	var count int
	if err := s.db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM app_release_note_read").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 1 {
		t.Fatalf("duplicate read records: %d", count)
	}
	other, err := s.GetReleaseNote(t.Context(), note.ID, machineB, 500)
	if err != nil || other.IsRead {
		t.Fatalf("other machine: %+v %v", other, err)
	}
}

func TestPublishEditOfflineAndUniqueVersion(t *testing.T) {
	s := openReleaseNotesTestStore(t)
	note := create(t, s, input("v0.1.1", Draft, nil), 100)
	if note.Version != "0.1.1" || note.PublishedAt != nil {
		t.Fatalf("draft: %+v", note)
	}
	published, err := s.UpdateReleaseNote(t.Context(), note.ID, input("0.1.1", Published, nil), 200)
	if err != nil || published.PublishedAt == nil || *published.PublishedAt != 200 {
		t.Fatalf("publish: %+v %v", published, err)
	}
	if _, err := s.MarkReleaseNoteRead(t.Context(), note.ID, machineA, 300); err != nil {
		t.Fatal(err)
	}
	edit := input("0.1.1", Published, nil)
	edit.ContentHTML = "<p>修改后的 HTML</p>"
	edited, err := s.UpdateReleaseNote(t.Context(), note.ID, edit, 400)
	if err != nil || edited.PublishedAt == nil || edited.CreatedAt != 100 || edited.UpdatedAt != 400 || *edited.PublishedAt != 200 {
		t.Fatalf("edit: %+v %v", edited, err)
	}
	detail, err := s.GetReleaseNote(t.Context(), note.ID, machineA, 500)
	if err != nil || !detail.IsRead || detail.ContentHTML != edit.ContentHTML {
		t.Fatalf("edited detail: %+v %v", detail, err)
	}
	if _, err := s.CreateReleaseNote(t.Context(), input("v0.1.1", Published, nil), 600); !errors.Is(err, ErrConflict) {
		t.Fatalf("duplicate: %v", err)
	}
	if _, err := s.UpdateReleaseNote(t.Context(), note.ID, input("0.1.1", Offline, pointer(int64(200))), 700); err != nil {
		t.Fatal(err)
	}
	if _, err := s.GetReleaseNote(t.Context(), note.ID, machineA, 800); !errors.Is(err, ErrNotFound) {
		t.Fatalf("offline: %v", err)
	}
}

func TestPersistenceReconnectPragmasAndCascadeDelete(t *testing.T) {
	path := filepath.Join(t.TempDir(), "数据库 with # space", "notes.db")
	s, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	note := create(t, s, input("0.1.1", Published, nil), 100)
	if _, err := s.MarkReleaseNoteRead(t.Context(), note.ID, machineA, 200); err != nil {
		_ = s.Close()
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = s.Close() })
	detail, err := s.GetReleaseNote(t.Context(), note.ID, machineA, 300)
	if err != nil || !detail.IsRead {
		t.Fatalf("reopen: %+v %v", detail, err)
	}
	s.db.SetMaxIdleConns(0) // Force each subsequent query to open a fresh connection.
	var foreignKeys, timeout int
	if err := s.db.QueryRowContext(t.Context(), "PRAGMA foreign_keys").Scan(&foreignKeys); err != nil {
		t.Fatal(err)
	}
	if err := s.db.QueryRowContext(t.Context(), "PRAGMA busy_timeout").Scan(&timeout); err != nil {
		t.Fatal(err)
	}
	if foreignKeys != 1 || timeout != 5000 {
		t.Fatalf("connection pragmas: %d, %d", foreignKeys, timeout)
	}
	if err := s.DeleteReleaseNote(t.Context(), note.ID); err != nil {
		t.Fatal(err)
	}
	var count int
	if err := s.db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM app_release_note_read").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 0 {
		t.Fatalf("orphaned reads: %d", count)
	}
	if err := s.DeleteReleaseNote(t.Context(), note.ID); !errors.Is(err, ErrNotFound) {
		t.Fatalf("second delete: %v", err)
	}
}

func TestRejectUnsupportedSchema(t *testing.T) {
	path := filepath.Join(t.TempDir(), "notes.db")
	s, err := Open(t.Context(), path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.ExecContext(t.Context(), "PRAGMA user_version = 99"); err != nil {
		_ = s.Close()
		t.Fatal(err)
	}
	_ = s.Close()
	if next, err := Open(t.Context(), path); err == nil {
		_ = next.Close()
		t.Fatal("accepted a newer schema")
	}
}

func TestInvalidInputAndCanceledContext(t *testing.T) {
	s := openReleaseNotesTestStore(t)
	cases := []NoteInput{
		{Version: "0.1.1", Title: "test", Status: nil},
		{Version: "garbage", Title: "test", Status: pointer(Draft)},
		{Version: "0.1.1", Title: "  ", Status: pointer(Draft)},
		{Version: "0.1.1", Title: "test", Status: pointer(9)},
		{Version: "0.1.1", Title: "test", Status: pointer(Published), ContentHTML: " "},
		{Version: "0.1.1", Title: "test", Status: pointer(Draft), PublishedAt: pointer(int64(-1))},
		{Version: "0.1.1", Title: "test", Status: pointer(Draft), ContentHTML: strings.Repeat("a", MaxHTMLBytes+1)},
	}
	for _, in := range cases {
		_, err := s.CreateReleaseNote(t.Context(), in, 100)
		var validation *ValidationError
		if !errors.As(err, &validation) {
			t.Fatalf("invalid input accepted: %+v %v", in.Status, err)
		}
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancel()
	if _, err := s.ListReleaseNotes(ctx, machineA, 100, 20, 0); !errors.Is(err, context.Canceled) {
		t.Fatalf("canceled context: %v", err)
	}
}

func TestConcurrentReadMarksKeepOneRecordPerMachine(t *testing.T) {
	s := openReleaseNotesTestStore(t)
	note := create(t, s, input("0.1.1", Published, nil), 100)
	var group sync.WaitGroup
	failures := make(chan error, 32)
	for i := range 32 {
		group.Add(1)
		go func() {
			defer group.Done()
			machine := machineA
			if i%2 == 1 {
				machine = machineB
			}
			_, err := s.MarkReleaseNoteRead(t.Context(), note.ID, machine, int64(200+i))
			failures <- err
		}()
	}
	group.Wait()
	close(failures)
	for err := range failures {
		if err != nil {
			t.Fatal(err)
		}
	}
	var count int
	if err := s.db.QueryRowContext(t.Context(), "SELECT COUNT(*) FROM app_release_note_read").Scan(&count); err != nil {
		t.Fatal(err)
	}
	if count != 2 {
		t.Fatalf("expected two machine records, got %d", count)
	}
	for machine, expected := range map[string]int64{machineA: 230, machineB: 231} {
		detail, err := s.GetReleaseNote(t.Context(), note.ID, machine, 500)
		if err != nil || detail.ReadAt == nil || *detail.ReadAt != expected {
			t.Fatalf("%s: %+v, %v", machine, detail, err)
		}
	}
}
