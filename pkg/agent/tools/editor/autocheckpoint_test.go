// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package editor

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/jj"
)

func callEditorTool(t *testing.T, name string, args map[string]any) map[string]any {
	t.Helper()
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
		t.Fatalf("%s failed: %s", name, res.ErrorText)
	}
	var out map[string]any
	if err := json.Unmarshal(res.Content, &out); err != nil {
		t.Fatalf("%s returned non-JSON content: %v", name, err)
	}
	return out
}

// normalizePath resolves symlinks, so on macOS a t.TempDir() under /var
// canonicalizes to /private/var. Resolving here keeps the repo root and the
// tool's idea of the path in agreement.
func resolvedTempDir(t *testing.T) string {
	t.Helper()
	resolved, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	return resolved
}

func trackedTempDir(t *testing.T) string {
	t.Helper()
	if !jj.Available() {
		t.Skip("jj not installed")
	}
	dir := resolvedTempDir(t)
	if _, _, err := jj.Init(context.Background(), dir); err != nil {
		t.Fatal(err)
	}
	return dir
}

// The property the vcs tooling advertises, now owned by the write itself: an
// edit in a tracked workspace is reversible without the model having thought
// to ask for a checkpoint first.
func TestWriteFileRecordsAUsableRestorePoint(t *testing.T) {
	dir := trackedTempDir(t)
	path := filepath.Join(dir, "app.go")
	callEditorTool(t, "editor.write_file", map[string]any{"path": path, "contents": "original\n"})

	out := callEditorTool(t, "editor.write_file", map[string]any{"path": path, "contents": "clobbered\n"})
	op, _ := out["restore_point"].(string)
	if op == "" {
		t.Fatalf("write in a tracked workspace returned no restore_point: %+v", out)
	}

	if _, err := jj.Restore(context.Background(), dir, op); err != nil {
		t.Fatalf("restore failed: %v", err)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "original\n" {
		t.Fatalf("file after restore = %q, want the pre-write contents", string(data))
	}
}

// Why the restore point is taken per write rather than once per session: a
// bad third edit has to be undoable without discarding the two good ones.
func TestApplyEditRestorePointRevertsOnlyThatEdit(t *testing.T) {
	dir := trackedTempDir(t)
	path := filepath.Join(dir, "conf.txt")
	callEditorTool(t, "editor.write_file", map[string]any{"path": path, "contents": "alpha\nbeta\n"})

	callEditorTool(t, "editor.apply_edit", map[string]any{"path": path, "old_text": "alpha", "new_text": "ALPHA"})
	second := callEditorTool(t, "editor.apply_edit", map[string]any{"path": path, "old_text": "beta", "new_text": "BETA"})

	op, _ := second["restore_point"].(string)
	if op == "" {
		t.Fatalf("apply_edit returned no restore_point: %+v", second)
	}
	if _, err := jj.Restore(context.Background(), dir, op); err != nil {
		t.Fatalf("restore failed: %v", err)
	}
	got, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(got) != "ALPHA\nbeta\n" {
		t.Fatalf("after restore = %q, want the first edit kept and the second reverted", string(got))
	}
}

// Untracked directories and machines without jj must keep working, and must
// not report a restore point nobody can use.
func TestWriteOutsideAWorkspaceSucceedsWithoutClaimingARestorePoint(t *testing.T) {
	path := filepath.Join(resolvedTempDir(t), "notes.txt")
	out := callEditorTool(t, "editor.write_file", map[string]any{"path": path, "contents": "hello\n"})

	if _, claimed := out["restore_point"]; claimed {
		t.Fatalf("untracked write must not claim a restore point: %+v", out)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != "hello\n" {
		t.Fatalf("file = %q, want the write to have gone through anyway", string(data))
	}
}
