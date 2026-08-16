// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package pathutil

import (
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// The fallback directories and the execute-bit test are Unix behaviour; on
// Windows LookPath is exec.LookPath and ExtraDirs is empty by design.
func skipOnWindows(t *testing.T) {
	t.Helper()
	if runtime.GOOS == "windows" {
		t.Skip("user bin fallback is not used on Windows")
	}
}

func writeExecutable(t *testing.T, dir string, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	return p
}

// The whole point of the package: a binary the user installed via a package
// manager must still resolve when PATH is the four directories a GUI launch
// hands us.
func TestLookPathFindsBinaryOutsidePATH(t *testing.T) {
	skipOnWindows(t)
	toolDir := t.TempDir()
	want := writeExecutable(t, toolDir, "somecli")
	t.Setenv("PATH", "/usr/bin:/bin")
	restore := UserBinDirs
	UserBinDirs = []string{toolDir}
	t.Cleanup(func() { UserBinDirs = restore })

	if got := LookPath("somecli"); got != want {
		t.Fatalf("LookPath = %q, want %q", got, want)
	}
}

func TestLookPathPrefersPATHOverFallback(t *testing.T) {
	skipOnWindows(t)
	pathDir, fallbackDir := t.TempDir(), t.TempDir()
	want := writeExecutable(t, pathDir, "dup")
	writeExecutable(t, fallbackDir, "dup")
	t.Setenv("PATH", pathDir)
	restore := UserBinDirs
	UserBinDirs = []string{fallbackDir}
	t.Cleanup(func() { UserBinDirs = restore })

	if got := LookPath("dup"); got != want {
		t.Fatalf("LookPath = %q, want the PATH copy %q", got, want)
	}
}

func TestLookPathReturnsEmptyWhenAbsent(t *testing.T) {
	t.Setenv("PATH", t.TempDir())
	restore := UserBinDirs
	UserBinDirs = []string{t.TempDir()}
	t.Cleanup(func() { UserBinDirs = restore })

	if got := LookPath("definitelynotinstalled"); got != "" {
		t.Fatalf("LookPath = %q, want empty", got)
	}
}

func TestLookPathIgnoresNonExecutableAndDirectories(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "notexec"), []byte("x"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(filepath.Join(dir, "adir"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Setenv("PATH", dir)
	restore := UserBinDirs
	UserBinDirs = nil
	t.Cleanup(func() { UserBinDirs = restore })

	if got := LookPath("notexec"); got != "" {
		t.Fatalf("non-executable resolved to %q", got)
	}
	if got := LookPath("adir"); got != "" {
		t.Fatalf("directory resolved to %q", got)
	}
}

func TestAugmentedPATHAppendsAndDoesNotDuplicate(t *testing.T) {
	skipOnWindows(t)
	onPath, extraDir := t.TempDir(), t.TempDir()
	t.Setenv("PATH", onPath)
	restore := UserBinDirs
	UserBinDirs = []string{onPath, extraDir}
	t.Cleanup(func() { UserBinDirs = restore })

	got := AugmentedPATH()
	parts := filepath.SplitList(got)
	if len(parts) != 2 || parts[0] != onPath || parts[1] != extraDir {
		t.Fatalf("AugmentedPATH = %q, want %q then %q with no repeat", got, onPath, extraDir)
	}
}

func TestEnvWithPATHReplacesExactlyOnePATH(t *testing.T) {
	skipOnWindows(t)
	extraDir := t.TempDir()
	t.Setenv("PATH", "/usr/bin")
	restore := UserBinDirs
	UserBinDirs = []string{extraDir}
	t.Cleanup(func() { UserBinDirs = restore })

	env := EnvWithPATH([]string{"FOO=1", "PATH=/stale", "BAR=2"})
	pathCount := 0
	var pathVal string
	for _, kv := range env {
		if strings.HasPrefix(kv, "PATH=") {
			pathCount++
			pathVal = strings.TrimPrefix(kv, "PATH=")
		}
	}
	if pathCount != 1 {
		t.Fatalf("got %d PATH entries, want exactly 1: %v", pathCount, env)
	}
	if strings.Contains(pathVal, "/stale") {
		t.Fatalf("stale PATH survived: %q", pathVal)
	}
	if !strings.Contains(pathVal, extraDir) {
		t.Fatalf("augmented dir missing from %q", pathVal)
	}
	for _, want := range []string{"FOO=1", "BAR=2"} {
		found := false
		for _, kv := range env {
			if kv == want {
				found = true
			}
		}
		if !found {
			t.Fatalf("EnvWithPATH dropped %s", want)
		}
	}
}

func TestLookPathHonoursExplicitPath(t *testing.T) {
	skipOnWindows(t)
	dir := t.TempDir()
	exe := writeExecutable(t, dir, "direct")
	if got := LookPath(exe); got != exe {
		t.Fatalf("LookPath(%q) = %q", exe, got)
	}
	if got := LookPath(filepath.Join(dir, "missing")); got != "" {
		t.Fatalf("missing explicit path resolved to %q", got)
	}
}
