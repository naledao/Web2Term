package store

import (
	"context"
	"encoding/json"
	"path/filepath"
	"sync"
	"testing"
	"time"
)

const deviceID = "aabbccdd-1234-5678-9abc-0123456789ab"

func openTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := Open(context.Background(), filepath.Join(t.TempDir(), "devices.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s
}

func TestDeviceLifecycleAndOwnerIsolation(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	list, err := s.List(ctx, 42)
	encoded, _ := json.Marshal(list)
	if err != nil || string(encoded) != "[]" {
		t.Fatalf("empty list must be a JSON array: %s, %v", encoded, err)
	}
	if ok, err := s.Connect(ctx, 42, deviceID, "first name"); err != nil || !ok {
		t.Fatalf("connect: %v %v", ok, err)
	}
	if ok, err := s.Rename(ctx, 43, deviceID, "intruder"); err != nil || ok {
		t.Fatalf("cross-owner rename: %v %v", ok, err)
	}
	if ok, err := s.Rename(ctx, 42, deviceID, "我的设备"); err != nil || !ok {
		t.Fatalf("rename: %v %v", ok, err)
	}
	// Renaming to the same value is still a successful owner-scoped update.
	if ok, err := s.Rename(ctx, 42, deviceID, "我的设备"); err != nil || !ok {
		t.Fatalf("unchanged rename: %v %v", ok, err)
	}
	if ok, err := s.Connect(ctx, 42, deviceID, "agent hostname"); err != nil || !ok {
		t.Fatalf("reconnect: %v %v", ok, err)
	}
	if ok, err := s.Connect(ctx, 43, deviceID, "intruder"); err != nil || ok {
		t.Fatalf("cross-owner connect: %v %v", ok, err)
	}
	if ok, err := s.Heartbeat(ctx, 42, deviceID); err != nil || !ok {
		t.Fatalf("heartbeat: %v %v", ok, err)
	}
	list, err = s.List(ctx, 42)
	if err != nil || len(list) != 1 || list[0].DeviceName != "我的设备" || list[0].OnlineStatus != 1 {
		t.Fatalf("device state: %+v, %v", list, err)
	}
	if list[0].TerminalSessionID != nil || list[0].LastHeartbeatAt == nil {
		t.Fatalf("nullable fields: %+v", list[0])
	}
	if _, err := time.Parse(time.RFC3339Nano, *list[0].LastHeartbeatAt); err != nil {
		t.Fatal("timestamps must be RFC3339:", err)
	}
	other, err := s.List(ctx, 43)
	if err != nil || len(other) != 0 {
		t.Fatalf("other owner's list: %+v, %v", other, err)
	}
	if err := s.Disconnect(ctx, 42, deviceID); err != nil {
		t.Fatal(err)
	}
	if ok, err := s.Heartbeat(ctx, 42, deviceID); err != nil || ok {
		t.Fatalf("offline heartbeat: %v %v", ok, err)
	}
}

func TestDisabledDeviceCannotReconnectOrHeartbeat(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if _, err := s.Connect(ctx, 42, deviceID, "device"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE user_device SET enabled = 0 WHERE device_id = ?", deviceID); err != nil {
		t.Fatal(err)
	}
	state, found, err := s.Auth(ctx, deviceID)
	if err != nil || !found || state.Enabled || state.UserID != 42 {
		t.Fatalf("auth state: %+v %v %v", state, found, err)
	}
	if ok, err := s.Connect(ctx, 42, deviceID, "new name"); err != nil || ok {
		t.Fatalf("disabled connect: %v %v", ok, err)
	}
	if ok, err := s.Heartbeat(ctx, 42, deviceID); err != nil || ok {
		t.Fatalf("disabled heartbeat: %v %v", ok, err)
	}
	if ok, err := s.Rename(ctx, 42, deviceID, "disabled but owned"); err != nil || !ok {
		t.Fatalf("disabled device rename: %v %v", ok, err)
	}
}

func TestRestartPersistsDevicesAndResetsPresence(t *testing.T) {
	ctx := context.Background()
	// '#' and spaces must be interpreted as filename characters, not URI options.
	path := filepath.Join(t.TempDir(), "设备 # data", "devices.db")
	s, err := Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.Connect(ctx, 42, deviceID, "saved device"); err != nil {
		t.Fatal(err)
	}
	if err := s.Close(); err != nil {
		t.Fatal(err)
	}
	s, err = Open(ctx, path)
	if err != nil {
		t.Fatal(err)
	}
	defer s.Close()
	list, err := s.List(ctx, 42)
	if err != nil || len(list) != 1 || list[0].DeviceName != "saved device" ||
		list[0].OnlineStatus != 0 || list[0].LastDisconnectedAt == nil {
		t.Fatalf("reopened device state: %+v, %v", list, err)
	}
	var mode string
	if err := s.db.QueryRow("PRAGMA journal_mode").Scan(&mode); err != nil || mode != "wal" {
		t.Fatalf("journal mode: %s, %v", mode, err)
	}
}

func TestConcurrentRegistrationCannotReassignDevice(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	var wg sync.WaitGroup
	winners := make(chan int64, 2)
	for _, owner := range []int64{42, 43} {
		wg.Go(func() {
			ok, err := s.Connect(ctx, owner, deviceID, "device")
			if err != nil {
				t.Error(err)
			} else if ok {
				winners <- owner
			}
		})
	}
	wg.Wait()
	close(winners)
	if len(winners) != 1 {
		t.Fatalf("expected exactly one owner, got %d", len(winners))
	}
}

func TestSchemaRejectsInvalidTerminalStateAndFutureVersion(t *testing.T) {
	s := openTestStore(t)
	ctx := context.Background()
	if _, err := s.Connect(ctx, 42, deviceID, "device"); err != nil {
		t.Fatal(err)
	}
	if _, err := s.db.Exec("UPDATE user_device SET terminal_connection_status = 2"); err == nil {
		t.Fatal("active terminal without its IDs must violate the schema constraint")
	}
	if _, err := s.db.Exec("PRAGMA user_version = 3"); err != nil {
		t.Fatal(err)
	}
	if err := initialize(ctx, s.db); err == nil {
		t.Fatal("future schema must be rejected")
	}
}
