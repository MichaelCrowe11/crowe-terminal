// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jj"
	"github.com/wavetermdev/waveterm/pkg/wavebase"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func stubJJ(t *testing.T, run func(dir string, args ...string) (string, string, error)) {
	t.Helper()
	restoreLook, restoreRun := jj.LookPath, jj.Run
	jj.LookPath = func() string { return "/stub/jj" }
	jj.Run = func(_ context.Context, dir string, args ...string) (string, string, error) {
		return run(dir, args...)
	}
	t.Cleanup(func() { jj.LookPath, jj.Run = restoreLook, restoreRun })
}

func TestVcsStatusNotInstalled(t *testing.T) {
	restore := jj.LookPath
	jj.LookPath = func() string { return "" }
	t.Cleanup(func() { jj.LookPath = restore })

	ws := &WshServer{}
	rtn, err := ws.VcsStatusCommand(context.Background(), wshrpc.CommandVcsStatusData{})
	if err != nil {
		t.Fatalf("missing jj must be a state, not an error: %v", err)
	}
	if rtn.Installed {
		t.Fatalf("installed should be false: %+v", rtn)
	}
}

func TestVcsStatusNotARepo(t *testing.T) {
	stubJJ(t, func(_ string, args ...string) (string, string, error) {
		return "", `Error: There is no jj repo in "."`, context.DeadlineExceeded
	})
	ws := &WshServer{}
	rtn, err := ws.VcsStatusCommand(context.Background(), wshrpc.CommandVcsStatusData{Path: t.TempDir()})
	if err != nil {
		t.Fatalf("untracked dir must be a state, not an error: %v", err)
	}
	if !rtn.Installed || rtn.IsRepo {
		t.Fatalf("want installed && !isrepo: %+v", rtn)
	}
}

func TestVcsStatusParsesDirtyTree(t *testing.T) {
	stubJJ(t, func(_ string, args ...string) (string, string, error) {
		switch args[0] {
		case "workspace":
			return "/repo/root\n", "", nil
		case "status":
			return "Working copy changes:\nM a.txt\n", "", nil
		case "diff":
			return "a.txt | 2 ++\n1 file changed, 2 insertions(+), 0 deletions(-)\n", "", nil
		}
		return "", "", nil
	})
	ws := &WshServer{}
	rtn, err := ws.VcsStatusCommand(context.Background(), wshrpc.CommandVcsStatusData{Path: t.TempDir()})
	if err != nil {
		t.Fatal(err)
	}
	if rtn.Clean || rtn.Root != "/repo/root" || len(rtn.Files) != 1 {
		t.Fatalf("status parsed wrong: %+v", rtn)
	}
	if rtn.Files[0] != (wshrpc.VcsFileChange{Path: "a.txt", Changes: 2, Plus: 2, Minus: 0}) {
		t.Fatalf("file change parsed wrong: %+v", rtn.Files[0])
	}
}

func TestVcsRestoreChoosesUndoVersusRestore(t *testing.T) {
	var captured [][]string
	stubJJ(t, func(_ string, args ...string) (string, string, error) {
		captured = append(captured, args)
		return "", "done", nil
	})
	ws := &WshServer{}
	dir := t.TempDir()
	if _, err := ws.VcsRestoreCommand(context.Background(), wshrpc.CommandVcsRestoreData{Path: dir}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(captured[0], " ") != "undo" {
		t.Fatalf("empty operation must mean a bare `jj undo`: %#v", captured[0])
	}
	if _, err := ws.VcsRestoreCommand(context.Background(), wshrpc.CommandVcsRestoreData{Path: dir, Operation: "abc123"}); err != nil {
		t.Fatal(err)
	}
	if strings.Join(captured[1], " ") != "op restore abc123" {
		t.Fatalf("operation id must mean `jj op restore <id>`: %#v", captured[1])
	}
}

func TestVcsOpFilesRequiresOperation(t *testing.T) {
	stubJJ(t, func(_ string, _ ...string) (string, string, error) { return "", "", nil })
	ws := &WshServer{}
	if _, err := ws.VcsOpFilesCommand(context.Background(), wshrpc.CommandVcsOpFilesData{Path: t.TempDir()}); err == nil {
		t.Fatal("expected an error for an empty operation id")
	}
}

func TestVcsInitRefusesHomeDir(t *testing.T) {
	stubJJ(t, func(_ string, _ ...string) (string, string, error) { return "", "", nil })
	ws := &WshServer{}
	_, err := ws.VcsInitCommand(context.Background(), wshrpc.CommandVcsInitData{Path: wavebase.GetHomeDir()})
	if err == nil || !strings.Contains(err.Error(), "home") {
		t.Fatalf("expected an error mentioning home for an explicit home-dir path, got: %v", err)
	}
	// An empty path resolves to the home directory too, so it must hit the
	// same guard.
	_, err = ws.VcsInitCommand(context.Background(), wshrpc.CommandVcsInitData{Path: ""})
	if err == nil || !strings.Contains(err.Error(), "home") {
		t.Fatalf("expected an error mentioning home for an empty path, got: %v", err)
	}
}
