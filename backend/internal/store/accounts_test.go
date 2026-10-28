package store

import (
	"context"
	"errors"
	"testing"
)

func TestLocalAccountsDoNotInheritExternalDeviceOwners(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	// Simulate schema 1 with an external user ID before the local-account migration.
	if _, err := s.db.Exec("DROP TABLE login_code; DROP TABLE user_account; PRAGMA user_version = 1"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.Connect(ctx, 42, deviceID, "legacy device"); err != nil {
		t.Fatal(err)
	}
	if err := initialize(ctx, s.db); err != nil {
		t.Fatal(err)
	}
	if err := s.ReserveCode(ctx, "fixture@example.invalid", []byte("hash"), 1000); err != nil {
		t.Fatal(err)
	}
	u, err := s.LoginWithCode(ctx, "fixture@example.invalid", []byte("hash"), 1001, "usr_fixture")
	if err != nil || u.ID <= 42 {
		t.Fatalf("local user reused external ID: %d %v", u.ID, err)
	}
}

func TestDisabledAccountAndTokenRevocationState(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if err := s.ReserveCode(ctx, "fixture@example.invalid", []byte("hash"), 1000); err != nil {
		t.Fatal(err)
	}
	u, err := s.LoginWithCode(ctx, "fixture@example.invalid", []byte("hash"), 1001, "usr_fixture")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE user_account SET enabled = 0, token_version = 1 WHERE id = ?", u.ID); err != nil {
		t.Fatal(err)
	}
	if err := s.ReserveCode(ctx, u.Email, []byte("second hash"), 1061); err != nil {
		t.Fatal(err)
	}
	if _, err := s.LoginWithCode(ctx, u.Email, []byte("second hash"), 1062, "usr_other"); !errors.Is(err, ErrUserDisabled) {
		t.Fatalf("disabled user login: %v", err)
	}
	saved, err := s.UserByID(ctx, u.ID)
	if err != nil || saved.Enabled || saved.TokenVersion != 1 {
		t.Fatalf("revocation state: %+v, %v", saved, err)
	}
}
