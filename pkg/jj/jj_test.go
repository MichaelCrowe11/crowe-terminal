// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package jj

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestParseOperations(t *testing.T) {
	out := "abc123\tsnapshot working copy\t2026-08-08 15:33:55\n" +
		"def456\tadd workspace 'default'\t2026-08-08 15:33:54\n" +
		"000000\t\t1970-01-01 00:00:00\n"
	ops := parseOperations(out)
	if len(ops) != 3 {
		t.Fatalf("got %d operations, want 3", len(ops))
	}
	if ops[0].ID != "abc123" || ops[0].Description != "snapshot working copy" {
		t.Fatalf("first operation parsed wrong: %+v", ops[0])
	}
	if ops[2].Description != "" {
		t.Fatalf("empty description should stay empty: %+v", ops[2])
	}
	if len(parseOperations("")) != 0 {
		t.Fatal("empty output should yield no operations")
	}
}

func TestParseOperationsFourFields(t *testing.T) {
	out := "abc123\tsnapshot working copy\t2026-08-09 07:05:33\t3 minutes ago\n"
	ops := parseOperations(out)
	if len(ops) != 1 || ops[0].TimeRel != "3 minutes ago" {
		t.Fatalf("relative time not parsed: %+v", ops)
	}
	if data, _ := json.Marshal(ops[0]); strings.Contains(string(data), "3 minutes ago") {
		t.Fatalf("TimeRel must not leak into JSON (agent payload compatibility): %s", data)
	}
}

func TestClampLimit(t *testing.T) {
	cases := map[int]int{0: DefaultLogN, -5: DefaultLogN, 7: 7, 99999: MaxLogN}
	for in, want := range cases {
		if got := ClampLimit(in); got != want {
			t.Fatalf("ClampLimit(%d) = %d, want %d", in, got, want)
		}
	}
}

func withStubRun(t *testing.T, stub func(dir string, args ...string) (string, string, error)) {
	t.Helper()
	restoreLook, restoreRun := LookPath, Run
	LookPath = func() string { return "/stub/jj" }
	Run = func(_ context.Context, dir string, args ...string) (string, string, error) {
		return stub(dir, args...)
	}
	t.Cleanup(func() { LookPath, Run = restoreLook, restoreRun })
}

func TestWorkspaceRootNotARepo(t *testing.T) {
	withStubRun(t, func(_ string, _ ...string) (string, string, error) {
		return "", `Error: There is no jj repo in "."`, errors.New("exit status 1")
	})
	if _, err := WorkspaceRoot(context.Background(), "/tmp"); !errors.Is(err, ErrNotRepo) {
		t.Fatalf("want ErrNotRepo, got %v", err)
	}
}

func TestWorkspaceRootTrimsOutput(t *testing.T) {
	withStubRun(t, func(_ string, _ ...string) (string, string, error) {
		return "/Users/me/proj\n", "", nil
	})
	root, err := WorkspaceRoot(context.Background(), "/tmp")
	if err != nil || root != "/Users/me/proj" {
		t.Fatalf("root = %q, err = %v", root, err)
	}
}

func TestParseStatLines(t *testing.T) {
	out := "a.txt | 2 ++\n" +
		"dir/b name.txt   | 3 +--\n" +
		"2 files changed, 3 insertions(+), 2 deletions(-)\n"
	files := parseStatLines(out)
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2: %+v", len(files), files)
	}
	if files[0] != (FileChange{Path: "a.txt", Changes: 2, Plus: 2, Minus: 0}) {
		t.Fatalf("first file parsed wrong: %+v", files[0])
	}
	if files[1] != (FileChange{Path: "dir/b name.txt", Changes: 3, Plus: 1, Minus: 2}) {
		t.Fatalf("second file parsed wrong: %+v", files[1])
	}
}

// One op can change several commits; the same path may appear in more than
// one stat block and must be summed, and op-show header/graph lines must
// not match. Captured verbatim from `jj op show --stat` on jj 0.44.0 (user@
// host substituted for the machine's real hostname) for an absorb operation
// that split one file's edits into two ancestor commits: every non-final
// commit block is prefixed with a "│" (U+2502) graph continuation bar
// instead of plain spaces, so b.txt appears once bar-prefixed and once
// space-indented in the final block. Both occurrences must parse to the
// clean path "b.txt" and aggregate into one entry.
func TestParseStatLinesAggregatesOpShowOutput(t *testing.T) {
	out := "7d7bcbad6960 user@host default@ 12 seconds ago, lasted 17 milliseconds\n" +
		"absorb changes into 2 commits\n" +
		"args: jj absorb\n" +
		"\n" +
		"Changed commits:\n" +
		"○  + wmnplqvq 2bd8be1f (empty) (no description set)\n" +
		"│  0 files changed, 0 insertions(+), 0 deletions(-)\n" +
		"○  + sxnnyloy f203ee21 commit B\n" +
		"│  - sxnnyloy/1 180ea5d1 (hidden) commit B\n" +
		"│  - lwkywlym/0 82d60460 (hidden) (no description set)\n" +
		"│  b.txt | 2 +-\n" +
		"│  1 file changed, 1 insertion(+), 1 deletion(-)\n" +
		"○  + nplulton ed2c9172 commit A\n" +
		"   - nplulton/1 bddc44f7 (hidden) commit A\n" +
		"   - lwkywlym/0 82d60460 (hidden) (no description set)\n" +
		"   b.txt | 2 +-\n" +
		"   1 file changed, 1 insertion(+), 1 deletion(-)\n" +
		"\n" +
		"Changed working copy default@:\n" +
		"+ wmnplqvq 2bd8be1f (empty) (no description set)\n" +
		"- lwkywlym/0 82d60460 (hidden) (no description set)\n"
	files := parseStatLines(out)
	if len(files) != 1 {
		t.Fatalf("got %d files, want 1: %+v", len(files), files)
	}
	if files[0] != (FileChange{Path: "b.txt", Changes: 4, Plus: 2, Minus: 2}) {
		t.Fatalf("aggregation wrong: %+v", files[0])
	}
}

func TestDiffStatAndOpFilesAgainstRealRepo(t *testing.T) {
	if !Available() {
		t.Skip("jj not installed")
	}
	ctx := context.Background()
	dir := t.TempDir()
	if _, _, err := Run(ctx, dir, "git", "init"); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "a.txt"), []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if _, _, err := Run(ctx, dir, "status"); err != nil {
		t.Fatal(err)
	}
	root, err := WorkspaceRoot(ctx, dir)
	if err != nil || root == "" {
		t.Fatalf("root = %q, err = %v", root, err)
	}
	files, err := DiffStat(ctx, dir)
	if err != nil || len(files) == 0 {
		t.Fatalf("DiffStat files = %+v, err = %v", files, err)
	}
	ops, err := History(ctx, dir, 5)
	if err != nil || len(ops) == 0 {
		t.Fatalf("History ops = %+v, err = %v", ops, err)
	}
	opFiles, err := OpFiles(ctx, dir, ops[0].ID)
	if err != nil {
		t.Fatalf("OpFiles err = %v", err)
	}
	found := false
	for _, f := range opFiles {
		if f.Path == "a.txt" {
			found = true
		}
	}
	if !found {
		t.Fatalf("newest op should include a.txt: %+v", opFiles)
	}
}
