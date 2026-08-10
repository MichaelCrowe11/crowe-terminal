// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

// The dock's whole promise, exercised through the real handlers against the
// real jj binary: an untracked directory becomes tracked, edits show up as
// counted file changes, and one restore call puts a wrecked tree back. The
// other vcs tests stub the jj seam, so this is the only place the full chain
// (resolveVcsDir -> pkg/jj -> jj 0.44 -> parsing -> wire types) runs together.
func TestVcsCommandsAgainstRealRepo(t *testing.T) {
	if !jj.Available() {
		t.Skip("jj not installed")
	}
	ctx := context.Background()
	ws := &WshServer{}
	dir := t.TempDir()

	status, err := ws.VcsStatusCommand(ctx, wshrpc.CommandVcsStatusData{Path: dir})
	if err != nil {
		t.Fatalf("status on an untracked dir must be a state, not an error: %v", err)
	}
	if !status.Installed || status.IsRepo {
		t.Fatalf("want installed && !isrepo before init, got %+v", status)
	}

	initRtn, err := ws.VcsInitCommand(ctx, wshrpc.CommandVcsInitData{Path: dir})
	if err != nil {
		t.Fatalf("init failed: %v", err)
	}
	if initRtn.AlreadyInitialized {
		t.Fatalf("a fresh dir should not report alreadyinitialized: %+v", initRtn)
	}

	keep := filepath.Join(dir, "keep.txt")
	if err := os.WriteFile(keep, []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	status, err = ws.VcsStatusCommand(ctx, wshrpc.CommandVcsStatusData{Path: dir})
	if err != nil {
		t.Fatal(err)
	}
	if !status.IsRepo || status.Clean {
		t.Fatalf("want a dirty tracked tree, got %+v", status)
	}
	if len(status.Files) == 0 {
		t.Fatalf("a new file should appear in the changed-file list: %+v", status)
	}
	found := false
	for _, f := range status.Files {
		if f.Path == "keep.txt" {
			found = true
			if f.Changes == 0 {
				t.Fatalf("keep.txt reported zero changed lines: %+v", f)
			}
		}
	}
	if !found {
		t.Fatalf("keep.txt missing from status files: %+v", status.Files)
	}

	hist, err := ws.VcsHistoryCommand(ctx, wshrpc.CommandVcsHistoryData{Path: dir, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(hist.Operations) == 0 {
		t.Fatal("history should carry at least the init and snapshot operations")
	}
	restorePoint := hist.Operations[0]
	if restorePoint.OpId == "" || restorePoint.TimeRel == "" {
		t.Fatalf("operation is missing the fields the panel renders: %+v", restorePoint)
	}

	opFiles, err := ws.VcsOpFilesCommand(ctx, wshrpc.CommandVcsOpFilesData{Path: dir, Operation: restorePoint.OpId})
	if err != nil {
		t.Fatalf("opfiles failed: %v", err)
	}
	for _, f := range opFiles.Files {
		if strings.ContainsAny(f.Path, "│├─○◆") {
			t.Fatalf("graph decoration leaked into a file path: %q", f.Path)
		}
	}

	// The agent goes wrong: deletes the file it was meant to edit, adds garbage.
	if err := os.Remove(keep); err != nil {
		t.Fatal(err)
	}
	junk := filepath.Join(dir, "junk.txt")
	if err := os.WriteFile(junk, []byte("oops\n"), 0o600); err != nil {
		t.Fatal(err)
	}

	if _, err := ws.VcsRestoreCommand(ctx, wshrpc.CommandVcsRestoreData{Path: dir, Operation: restorePoint.OpId}); err != nil {
		t.Fatalf("restore failed: %v", err)
	}

	if _, err := os.Stat(keep); err != nil {
		t.Fatalf("the deleted file was not restored: %v", err)
	}
	if _, err := os.Stat(junk); !os.IsNotExist(err) {
		t.Fatalf("a file created after the restore point should be gone, stat err = %v", err)
	}

	// A restore is itself an operation, so the panel can always undo an undo.
	after, err := ws.VcsHistoryCommand(ctx, wshrpc.CommandVcsHistoryData{Path: dir, Limit: 10})
	if err != nil {
		t.Fatal(err)
	}
	if len(after.Operations) <= len(hist.Operations) {
		t.Fatalf("the restore should have been recorded as a new operation: %d -> %d",
			len(hist.Operations), len(after.Operations))
	}
}
