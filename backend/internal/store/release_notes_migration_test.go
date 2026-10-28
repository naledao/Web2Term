package store

import (
	"database/sql"
	"path/filepath"
	"testing"
)

func legacyV2(t *testing.T, path string) *Store {
	t.Helper()
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	db.SetMaxOpenConns(1)
	if _, err := db.Exec(schema + authSchema + "PRAGMA user_version = 2;"); err != nil {
		db.Close()
		t.Fatal(err)
	}
	return &Store{db: db}
}

func TestReleaseNotesMigrationPreservesAccountsDevicesAndReadState(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backend.db")
	old := legacyV2(t, path)
	ctx := t.Context()
	if err := old.ReserveCode(ctx, "fixture@example.invalid", []byte("fixture-hash"), 1000); err != nil {
		t.Fatal(err)
	}
	user, err := old.LoginWithCode(ctx, "fixture@example.invalid", []byte("fixture-hash"), 1001, "usr_fixture")
	if err != nil {
		t.Fatal(err)
	}
	if ok, err := old.Connect(ctx, user.ID, deviceID, "saved device"); err != nil || !ok {
		t.Fatalf("old device: %v %v", ok, err)
	}
	if err := old.ReserveCode(ctx, "pending@example.invalid", []byte("pending-hash"), 1100); err != nil {
		t.Fatal(err)
	}
	if err := old.Close(); err != nil {
		t.Fatal(err)
	}

	db, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	saved, err := db.UserByID(ctx, user.ID)
	if err != nil || saved.PublicID != user.PublicID || saved.Email != user.Email {
		t.Fatalf("account lost: %+v %v", saved, err)
	}
	devices, err := db.List(ctx, user.ID)
	if err != nil || len(devices) != 1 || devices[0].DeviceName != "saved device" || devices[0].OnlineStatus != 0 {
		t.Fatalf("devices lost: %+v %v", devices, err)
	}
	if _, err := db.LoginWithCode(ctx, "pending@example.invalid", []byte("pending-hash"), 1101, "usr_pending"); err != nil {
		t.Fatalf("pending login code lost: %v", err)
	}
	var version int
	if err := db.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 3 {
		t.Fatalf("schema version: %d %v", version, err)
	}
	status := Published
	note, err := db.CreateReleaseNote(ctx, NoteInput{Version: "0.1.200", Title: "release", ContentHTML: "<p>HTML</p>", Status: &status}, 2000)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := db.MarkReleaseNoteRead(ctx, note.ID, machineA, 2001); err != nil {
		t.Fatal(err)
	}
	if err := db.Close(); err != nil {
		t.Fatal(err)
	}
	db, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	detail, err := db.GetReleaseNote(ctx, note.ID, machineA, 3000)
	if err != nil || !detail.IsRead || detail.ReadAt == nil || *detail.ReadAt != 2001 {
		t.Fatalf("read state lost on reopen: %+v %v", detail, err)
	}
	if _, err := db.UserByID(ctx, user.ID); err != nil {
		t.Fatal("account missing after reopen:", err)
	}
}

func TestFailedReleaseNotesMigrationRollsBack(t *testing.T) {
	path := filepath.Join(t.TempDir(), "backend.db")
	old := legacyV2(t, path)
	// A conflicting table forces the migration to fail after its first DDL.
	if _, err := old.db.Exec("CREATE TABLE app_release_note_read (unexpected INTEGER)"); err != nil {
		t.Fatal(err)
	}
	old.Close()
	if next, err := Open(t.Context(), path); err == nil {
		next.Close()
		t.Fatal("conflicting migration was accepted")
	}
	db, err := sql.Open("sqlite", path)
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	var version, created int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 2 {
		t.Fatalf("version changed on failure: %d %v", version, err)
	}
	if err := db.QueryRow("SELECT COUNT(*) FROM sqlite_master WHERE name = 'app_release_note'").Scan(&created); err != nil || created != 0 {
		t.Fatalf("partially applied table persisted: %d %v", created, err)
	}
}
