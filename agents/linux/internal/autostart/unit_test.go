package autostart

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

func fixtureSpec(t *testing.T) serviceSpec {
	t.Helper()
	home := filepath.Join(t.TempDir(), "home with spaces %n $HOME")
	return serviceSpec{uid: "1001", gid: "1002", home: home,
		executable: filepath.Join(home, "bin", "web2term"),
		config:     filepath.Join(home, "custom config", "web2term", "config.json")}
}

func TestUnitPinsOriginalIdentityAndConfiguration(t *testing.T) {
	spec := fixtureSpec(t)
	text, err := render(spec)
	if err != nil {
		t.Fatal(err)
	}
	for _, part := range []string{marker, "User=1001\n", "Group=1002\n", "Type=simple\n",
		"Restart=on-failure\n", "RestartPreventExitStatus=78\n", "WantedBy=multi-user.target\n",
		"StartLimitBurst=3\n", "KillMode=control-group\n", " __service ", "%%n", "$$HOME"} {
		if !strings.Contains(text, part) {
			t.Fatalf("missing %q in service: %s", part, text)
		}
	}
	if strings.Contains(text, "access_token") || strings.Contains(text, "loginctl") || strings.Contains(text, " run\n") {
		t.Fatal("service exposes credentials or launches a detached wrapper")
	}
	if name, err := unitName("0"); err != nil || name != "web2term-0.service" {
		t.Fatal("direct root installations must also have a stable service name")
	}
}

func TestRejectInvalidIdentityAndUnitInjection(t *testing.T) {
	for _, uid := range []string{"", "../root", "-1", "01001", "1001\nUser=0", "4294967296"} {
		if _, err := unitName(uid); err == nil {
			t.Fatalf("accepted invalid UID %q", uid)
		}
	}
	for _, mutate := range []func(*serviceSpec){
		func(s *serviceSpec) { s.config = "relative.json" },
		func(s *serviceSpec) { s.home += "\nUser=0" },
		func(s *serviceSpec) { s.executable += "\x00" },
		func(s *serviceSpec) { s.gid = "root" },
	} {
		spec := fixtureSpec(t)
		mutate(&spec)
		if _, err := render(spec); err == nil {
			t.Fatal("accepted invalid service parameters")
		}
	}
	quoted, err := quote(`a"b\c %h $HOME`, true)
	if err != nil || quoted != `"a\"b\\c %%h $$HOME"` {
		t.Fatalf("unsafe systemd quoting: %q, %v", quoted, err)
	}
}

func fakeManager(t *testing.T, active string) (manager, *[][]string) {
	t.Helper()
	calls := make([][]string, 0)
	m := manager{dir: t.TempDir()}
	m.command = func(args ...string) (string, error) {
		calls = append(calls, append([]string{}, args...))
		if args[0] == "show" {
			return active + "\n", nil
		}
		return "", nil
	}
	m.stop = func(path string) (bool, error) {
		calls = append(calls, []string{"stop-manual-worker", path})
		return true, nil
	}
	return m, &calls
}

func TestEnableMigratesManualWorkerBeforeStartingService(t *testing.T) {
	m, calls := fakeManager(t, "inactive")
	spec := fixtureSpec(t)
	if err := m.enable(spec); err != nil {
		t.Fatal(err)
	}
	name, _ := unitName(spec.uid)
	expected := [][]string{{"daemon-reload"}, {"enable", name},
		{"show", "--property=ActiveState", "--value", name}, {"stop", name},
		{"stop-manual-worker", spec.config}, {"reset-failed", name}, {"start", name}}
	if !reflect.DeepEqual(*calls, expected) {
		t.Fatalf("unexpected lifecycle ordering: %v", *calls)
	}
	data, err := os.ReadFile(filepath.Join(m.dir, name))
	if err != nil || !strings.Contains(string(data), " __service ") {
		t.Fatal("unit was not installed")
	}
}

func TestRepeatedEnableKeepsRunningTerminals(t *testing.T) {
	m, calls := fakeManager(t, "active")
	spec := fixtureSpec(t)
	content, _ := render(spec)
	name, _ := unitName(spec.uid)
	if err := os.WriteFile(filepath.Join(m.dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := m.enable(spec); err != nil {
		t.Fatal(err)
	}
	for _, call := range *calls {
		if call[0] == "stop" || call[0] == "start" || call[0] == "stop-manual-worker" {
			t.Fatal("idempotent enable interrupted a running worker")
		}
	}
}

func TestUnmanagedUnitIsPreservedForEnableAndDisable(t *testing.T) {
	m, calls := fakeManager(t, "inactive")
	spec := fixtureSpec(t)
	name, _ := unitName(spec.uid)
	path := filepath.Join(m.dir, name)
	original := []byte("[Service]\nExecStart=/some/other/program\n")
	if err := os.WriteFile(path, original, 0o644); err != nil {
		t.Fatal(err)
	}
	if m.enable(spec) == nil || m.disable(spec.uid) == nil {
		t.Fatal("unmanaged service was modified")
	}
	data, _ := os.ReadFile(path)
	if string(data) != string(original) || len(*calls) != 0 {
		t.Fatal("unmanaged service was not left untouched")
	}
}

func TestDisableIsRepeatableAndDoesNotReadLogin(t *testing.T) {
	m, calls := fakeManager(t, "active")
	if err := m.disable("1001"); err != nil || len(*calls) != 0 {
		t.Fatal("disabling an absent unit should be harmless")
	}
	spec := fixtureSpec(t) // deliberately no config or login file exists
	content, _ := render(spec)
	name, _ := unitName(spec.uid)
	if err := os.WriteFile(filepath.Join(m.dir, name), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	for range 2 {
		if err := m.disable(spec.uid); err != nil {
			t.Fatal(err)
		}
	}
	if !reflect.DeepEqual(*calls, [][]string{{"disable", "--now", name}, {"disable", "--now", name}}) {
		t.Fatal("disable must stop and disable only the selected user's unit")
	}
	if _, err := os.Stat(filepath.Join(m.dir, name)); err != nil {
		t.Fatal("disabled unit should remain available for re-enabling")
	}
}

func TestFailureDoesNotStartSecondWorker(t *testing.T) {
	for _, failAt := range []string{"daemon-reload", "enable", "show", "stop", "stop-manual-worker", "reset-failed", "start"} {
		t.Run(failAt, func(t *testing.T) {
			m, calls := fakeManager(t, "inactive")
			command, stop := m.command, m.stop
			m.command = func(args ...string) (string, error) {
				if args[0] == failAt {
					return "", errors.New("fixture failure")
				}
				return command(args...)
			}
			m.stop = func(path string) (bool, error) {
				if failAt == "stop-manual-worker" {
					return false, errors.New("fixture worker did not stop")
				}
				return stop(path)
			}
			if err := m.enable(fixtureSpec(t)); err == nil {
				t.Fatal("failure was reported as success")
			}
			for _, call := range *calls {
				if call[0] == "start" {
					t.Fatal("started worker after a prerequisite failed")
				}
			}
		})
	}
}
