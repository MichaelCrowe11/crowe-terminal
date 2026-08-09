// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package vcs

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/jj"
)

func callTool(t *testing.T, name string, args map[string]any) map[string]any {
	t.Helper()
	if !jj.Available() {
		t.Skip("jj not installed; tools are deliberately not registered")
	}
	tool, ok := registry.Default().Get(name)
	if !ok {
		t.Fatalf("%s not registered", name)
	}
	raw, err := json.Marshal(args)
	if err != nil {
		t.Fatal(err)
	}
	res, err := tool.Handler(context.Background(), raw)
	if err != nil {
		t.Fatalf("%s returned a Go error instead of a result: %v", name, err)
	}
	if res.IsError {
		return map[string]any{"__error": res.ErrorText}
	}
	var out map[string]any
	if err := json.Unmarshal(res.Content, &out); err != nil {
		t.Fatalf("%s returned non-JSON content: %v", name, err)
	}
	return out
}

func errorOf(m map[string]any) string {
	if s, ok := m["__error"].(string); ok {
		return s
	}
	return ""
}

func TestToolsRegisteredWithExpectedMutability(t *testing.T) {
	if !jj.Available() {
		t.Skip("jj not installed; tools are deliberately not registered")
	}
	cases := map[string]bool{
		"vcs.init":       true,
		"vcs.status":     false,
		"vcs.checkpoint": false,
		"vcs.diff":       false,
		"vcs.history":    false,
		"vcs.undo":       true,
	}
	for name, mutating := range cases {
		tool, ok := registry.Default().Get(name)
		if !ok {
			t.Fatalf("%s not registered", name)
		}
		if tool.Mutating != mutating {
			t.Fatalf("%s mutating=%t, want %t", name, tool.Mutating, mutating)
		}
		var schema map[string]any
		if err := json.Unmarshal(tool.Schema, &schema); err != nil {
			t.Fatalf("%s has an invalid schema: %v", name, err)
		}
	}
}

func TestPathValidation(t *testing.T) {
	cases := []struct {
		name string
		path string
		want string
	}{
		{"empty", "", "path required"},
		{"relative", "some/dir", "must be absolute"},
		{"system path", "/System/Library", "system path"},
		{"usr", "/usr/local/thing", "system path"},
		{"missing", "/nonexistent-abcdef-123", "cannot stat"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := errorOf(callTool(t, "vcs.status", map[string]any{"path": tc.path}))
			if !strings.Contains(got, tc.want) {
				t.Fatalf("error = %q, want it to mention %q", got, tc.want)
			}
		})
	}
}

func TestFileTargetIsRejected(t *testing.T) {
	f := filepath.Join(t.TempDir(), "a.txt")
	if err := os.WriteFile(f, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	if got := errorOf(callTool(t, "vcs.status", map[string]any{"path": f})); !strings.Contains(got, "not a directory") {
		t.Fatalf("error = %q, want it to mention 'not a directory'", got)
	}
}

// A model-supplied revision or label must reach jj as one argv element, never
// as something a shell could split or interpret.
func TestArgumentsAreNotShellInterpreted(t *testing.T) {
	dir := t.TempDir()
	var captured []string
	restore := jj.Run
	jj.Run = func(_ context.Context, _ string, args ...string) (string, string, error) {
		captured = args
		return "", "", nil
	}
	defer func() { jj.Run = restore }()

	callTool(t, "vcs.diff", map[string]any{"path": dir, "revision": "; rm -rf / #"})
	joined := strings.Join(captured, "\x00")
	if !strings.Contains(joined, "; rm -rf / #") {
		t.Fatalf("revision did not survive as a single argv element: %#v", captured)
	}
	for _, a := range captured {
		if a == "rm" || a == "-rf" {
			t.Fatalf("argument was split as if by a shell: %#v", captured)
		}
	}
}

func TestHistoryClampsLimit(t *testing.T) {
	dir := t.TempDir()
	var captured []string
	restore := jj.Run
	jj.Run = func(_ context.Context, _ string, args ...string) (string, string, error) {
		captured = args
		return "", "", nil
	}
	defer func() { jj.Run = restore }()

	callTool(t, "vcs.history", map[string]any{"path": dir, "limit": 99999})
	for i, a := range captured {
		if a == "-n" && i+1 < len(captured) {
			if captured[i+1] != "200" {
				t.Fatalf("limit not clamped to MaxLogN: got -n %s", captured[i+1])
			}
			return
		}
	}
	t.Fatalf("no -n flag passed to jj: %#v", captured)
}

func TestUndoWithoutOperationUndoesOnlyTheLastOne(t *testing.T) {
	dir := t.TempDir()
	var captured []string
	restore := jj.Run
	jj.Run = func(_ context.Context, _ string, args ...string) (string, string, error) {
		captured = args
		return "", "done", nil
	}
	defer func() { jj.Run = restore }()

	out := callTool(t, "vcs.undo", map[string]any{"path": dir})
	if strings.Join(captured, " ") != "undo" {
		t.Fatalf("want a bare `jj undo`, got %#v", captured)
	}
	if out["mode"] != "last-operation" {
		t.Fatalf("mode = %v, want last-operation", out["mode"])
	}
}

// The whole point of the package: an agent wrecks a tree, and one call puts it
// back. Exercises the real jj binary end to end.
func TestCheckpointSurvivesAWreckedTree(t *testing.T) {
	if !jj.Available() {
		t.Skip("jj not installed")
	}
	dir := t.TempDir()

	if out := callTool(t, "vcs.init", map[string]any{"path": dir}); errorOf(out) != "" {
		t.Fatalf("init failed: %s", errorOf(out))
	}
	keep := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(keep, []byte("precious\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	ck := callTool(t, "vcs.checkpoint", map[string]any{"path": dir, "label": "before edit"})
	if errorOf(ck) != "" {
		t.Fatalf("checkpoint failed: %s", errorOf(ck))
	}
	opID, _ := ck["operation"].(string)
	if opID == "" {
		t.Fatalf("checkpoint returned no operation id: %+v", ck)
	}

	// The agent goes wrong: deletes the file it was meant to edit, adds garbage.
	if err := os.Remove(keep); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "junk.txt"), []byte("oops\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if out := callTool(t, "vcs.undo", map[string]any{"path": dir, "operation": opID}); errorOf(out) != "" {
		t.Fatalf("undo failed: %s", errorOf(out))
	}

	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("deleted file was not restored: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, "junk.txt")); !os.IsNotExist(err) {
		t.Fatalf("file created after the checkpoint should be gone, stat err = %v", err)
	}
}

func TestInitIsIdempotentAndAddsNoRemote(t *testing.T) {
	if !jj.Available() {
		t.Skip("jj not installed")
	}
	dir := t.TempDir()

	first := callTool(t, "vcs.init", map[string]any{"path": dir})
	if errorOf(first) != "" {
		t.Fatalf("init failed: %s", errorOf(first))
	}
	if first["remote"] != nil {
		t.Fatalf("init must not configure a remote, got %v", first["remote"])
	}
	second := callTool(t, "vcs.init", map[string]any{"path": dir})
	if second["already_initialized"] != true {
		t.Fatalf("second init should report already_initialized: %+v", second)
	}
}

func TestHistoryListsRestorePointsAgainstRealRepo(t *testing.T) {
	if !jj.Available() {
		t.Skip("jj not installed")
	}
	dir := t.TempDir()
	callTool(t, "vcs.init", map[string]any{"path": dir})
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("hi\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	callTool(t, "vcs.checkpoint", map[string]any{"path": dir})

	out := callTool(t, "vcs.history", map[string]any{"path": dir, "limit": 5})
	ops, _ := out["operations"].([]any)
	if len(ops) == 0 {
		t.Fatalf("expected at least one operation: %+v", out)
	}
	first, _ := ops[0].(map[string]any)
	if id, _ := first["id"].(string); id == "" {
		t.Fatalf("operation entry has no id: %+v", first)
	}
}
