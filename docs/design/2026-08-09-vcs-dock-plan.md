# Repository Dock Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A dock panel that shows what the agent's edits changed and restores the tree with one click, backed by the jj operation log.

**Architecture:** Extract the jj-driving core from `pkg/agent/tools/vcs` into a shared `pkg/jj` package consumed by both the (behavior-unchanged) agent tools and five new wshrpc commands. The frontend is one Jotai singleton model plus one panel registered in the existing utility dock, polling `VcsStatusCommand` every 10s for the rail's dirty pip.

**Tech Stack:** Go (backend + wshrpc), TypeScript/React/Jotai (frontend), jj 0.44 (git backend only), vitest, the repo's preview harness.

**Spec:** `docs/design/2026-08-09-vcs-dock.md` (commit 5826a0af).

## Deviations from the spec (flag these to Michael)

The spec's RPC table lists three commands. This plan implements **five**, because the spec's own surface requires the extra two:

1. `VcsInitCommand` — the spec's error-handling section says "Directory is not a repository: offer to initialize", and the frontend cannot reach the agent's `vcs.init` tool (wrong layer, agent auth key).
2. `VcsOpFilesCommand` — "Selecting a row expands its changed files inline" needs per-operation file data. Fetching it eagerly for every history row would mean ~30 jj invocations per refresh; a lazy dedicated command keeps `VcsStatusCommand`'s contract clean instead of overloading it with a mode flag.

Also: per-file +/- counts come from parsing git-style `--stat` bars, which jj scales proportionally on very large diffs, so counts are honest approximations there (exact on normal-sized diffs).

## Global Constraints

- **Execute in the main checkout on `feat/agent-vcs-jujutsu` — NOT an isolated worktree.** The working tree carries an uncommitted left-dock migration (utilitydock.tsx, dock.scss, crowe-icons.tsx, theme.scss, workspace.tsx, wave.ts, tailwindsetup.css) from a parallel session; a worktree would not contain it and Task 5 must layer on top of it.
- Behavior-preserving extraction: every agent tool payload key and error string stays byte-identical (`already_initialized`, `restore_with`, `jj last-operation failed: …`, etc.).
- wshrpc JSON tags: all lowercase, no underscores. Method names end with `Command`. After editing `pkg/wshrpc/wshrpctypes.go`, run `task generate`; never hand-edit `frontend/types/gotypes.d.ts` or `frontend/app/store/wshclientapi.ts`.
- Never run `go build`; editor diagnostics prove compilation. Run Go tests from the repo root.
- TS: 4-space indent, named exports, `cn` from `@/util/util`, `cursor-pointer` on all clickables, Jotai singleton-model pattern (atoms on the model, `globalStore.get/set`, no hooks in models), hooks at component top level.
- No emojis anywhere in UI copy. No comments that merely describe code.
- jj absent is a normal state, never an error state. `jj git init` creates a local store with **no remote**. jj's native backend is not production-ready; the git backend is the only one in play.
- New files: `// Copyright 2026, Crowe Logic Inc.` + `// SPDX-License-Identifier: Apache-2.0`.
- Commit only the files each task names. The tree contains unrelated in-flight changes (`package-lock.json`, `frontend/app/theme/`, `output/`, `.playwright-cli/`) — never `git add -A`, never `git checkout`/`git restore` a file you did not author.

---

### Task 1: Extract the jj core into `pkg/jj` (behavior-preserving)

**Files:**
- Create: `pkg/jj/jj.go`
- Create: `pkg/jj/jj_test.go`
- Modify: `pkg/agent/tools/vcs/vcs.go` (all of it except registration/schemas/payload construction)
- Modify: `pkg/agent/tools/vcs/vcs_test.go` (re-point stubs; delete moved test)

**Interfaces:**
- Consumes: nothing new (moves existing code).
- Produces (exact, later tasks depend on these):
  - `jj.Available() bool`
  - `var jj.LookPath func() string` and `var jj.Run func(ctx context.Context, dir string, args ...string) (stdout, stderr string, err error)` — the test seams (were `jjPath`/`runJJ`)
  - `jj.ResolveDir(raw string) (string, error)`, `jj.Truncate(s string) (string, bool)`, `jj.FirstLine(stderr string, err error) string`, `jj.ClampLimit(n int) int`
  - `jj.Operation{ID string ` + "`json:\"id\"`" + `; Description string ` + "`json:\"description\"`" + `; Time string ` + "`json:\"time\"`" + `; TimeRel string ` + "`json:\"-\"`" + `}`
  - `jj.Init(ctx, dir) (colocated bool, already bool, err error)`
  - `jj.StatusText(ctx, dir) (text string, clean bool, err error)`
  - `jj.CheckpointID(ctx, dir) (string, error)`
  - `jj.DiffText(ctx, dir, revision string) (string, error)`
  - `jj.History(ctx, dir string, limit int) ([]Operation, error)`
  - `jj.Undo(ctx, dir) (detail string, err error)` and `jj.Restore(ctx, dir, op string) (detail string, err error)`
  - Constants `jj.DefaultTimeout`, `jj.MaxOutputBytes`, `jj.DefaultLogN`, `jj.MaxLogN`

- [ ] **Step 1: Create `pkg/jj/jj.go`**

Move these verbatim from `pkg/agent/tools/vcs/vcs.go` (keep their existing comments; rename only as noted): the four constants; `refusedPrefixes`; `jjPath` → exported `LookPath`; `runJJ` → exported `Run` (body updates its internal `jjPath()` call to `LookPath()`); `Available`; `resolveDir` → `ResolveDir`; `truncate` → `Truncate`; `firstLine` → `FirstLine`; the `operation` struct → `Operation` with the `TimeRel string `+"`json:\"-\"`"+` field appended (json:"-" keeps the agent payload byte-identical); `parseOperations` (stays unexported, update to `strings.SplitN(line, "\t", 4)` and fill `TimeRel` from `parts[3]`).

Package doc comment:

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jj is the single implementation of "how we talk to Jujutsu".
// Two consumers share it: the agent tools in pkg/agent/tools/vcs and the
// vcs wshrpc commands behind the repository dock panel. Keeping argv
// construction, error translation, and output parsing in one place means
// the two surfaces cannot drift apart.
package jj
```

Then add the command wrappers. Their error strings reproduce the agent handlers' current messages exactly:

```go
func ClampLimit(n int) int {
	if n <= 0 {
		return DefaultLogN
	}
	if n > MaxLogN {
		return MaxLogN
	}
	return n
}

func Init(ctx context.Context, dir string) (bool, bool, error) {
	if _, err := os.Stat(filepath.Join(dir, ".jj")); err == nil {
		return false, true, nil
	}
	// Colocating keeps git history and any existing tooling working alongside jj.
	args := []string{"git", "init"}
	colocated := false
	if _, err := os.Stat(filepath.Join(dir, ".git")); err == nil {
		args = append(args, "--colocate")
		colocated = true
	}
	if _, stderr, err := Run(ctx, dir, args...); err != nil {
		return false, false, fmt.Errorf("jj git init failed: %s", FirstLine(stderr, err))
	}
	return colocated, false, nil
}

func StatusText(ctx context.Context, dir string) (string, bool, error) {
	stdout, stderr, err := Run(ctx, dir, "status")
	if err != nil {
		return "", false, fmt.Errorf("jj status failed: %s", FirstLine(stderr, err))
	}
	return stdout, strings.Contains(stdout, "The working copy has no changes"), nil
}

// CheckpointID returns the newest operation id. `jj status` is the cheapest
// command that forces a working-copy snapshot, so the id already includes
// edits made moments ago.
func CheckpointID(ctx context.Context, dir string) (string, error) {
	if _, stderr, err := Run(ctx, dir, "status"); err != nil {
		return "", fmt.Errorf("jj status failed: %s", FirstLine(stderr, err))
	}
	stdout, stderr, err := Run(ctx, dir, "op", "log", "--no-graph", "-n", "1", "-T", "id.short()")
	if err != nil {
		return "", fmt.Errorf("jj op log failed: %s", FirstLine(stderr, err))
	}
	opID := strings.TrimSpace(stdout)
	if opID == "" {
		return "", fmt.Errorf("could not determine operation id")
	}
	return opID, nil
}

func DiffText(ctx context.Context, dir string, revision string) (string, error) {
	args := []string{"diff"}
	if rev := strings.TrimSpace(revision); rev != "" {
		args = append(args, "-r", rev)
	}
	stdout, stderr, err := Run(ctx, dir, args...)
	if err != nil {
		return "", fmt.Errorf("jj diff failed: %s", FirstLine(stderr, err))
	}
	return stdout, nil
}

func History(ctx context.Context, dir string, limit int) ([]Operation, error) {
	limit = ClampLimit(limit)
	stdout, stderr, err := Run(ctx, dir, "op", "log", "--no-graph",
		"-n", fmt.Sprint(limit),
		"-T", `id.short() ++ "\t" ++ description ++ "\t" ++ time.end() ++ "\t" ++ time.end().ago() ++ "\n"`)
	if err != nil {
		return nil, fmt.Errorf("jj op log failed: %s", FirstLine(stderr, err))
	}
	return parseOperations(stdout), nil
}

// jj reports undo/restore outcomes on stderr, which is the part worth
// showing back.
func Undo(ctx context.Context, dir string) (string, error) {
	stdout, stderr, err := Run(ctx, dir, "undo")
	if err != nil {
		return "", fmt.Errorf("jj last-operation failed: %s", FirstLine(stderr, err))
	}
	return restoreDetail(stdout, stderr), nil
}

func Restore(ctx context.Context, dir string, op string) (string, error) {
	stdout, stderr, err := Run(ctx, dir, "op", "restore", op)
	if err != nil {
		return "", fmt.Errorf("jj restore-to-operation failed: %s", FirstLine(stderr, err))
	}
	return restoreDetail(stdout, stderr), nil
}

func restoreDetail(stdout string, stderr string) string {
	detail := strings.TrimSpace(stderr)
	if detail == "" {
		detail = strings.TrimSpace(stdout)
	}
	return detail
}
```

Imports for the file: `context`, `fmt`, `os`, `os/exec`, `path/filepath`, `strings`, `time`.

- [ ] **Step 2: Create `pkg/jj/jj_test.go` with the moved parse test, run it**

Move `TestParseOperations` out of `pkg/agent/tools/vcs/vcs_test.go` into `pkg/jj/jj_test.go` (package `jj`), keeping the existing 3-field fixtures (they must still parse, with empty `TimeRel`) and adding a 4-field case plus a clamp test:

```go
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
```

Run: `cd /Users/crowelogic/Projects/hypheus && go test ./pkg/jj/...`
Expected: PASS.

- [ ] **Step 3: Rewire `pkg/agent/tools/vcs/vcs.go`**

Delete from the agent file everything that moved (constants, `refusedPrefixes`, `jjPath`, `runJJ`, `Available`, `resolveDir`, `truncate`, `firstLine`, `operation`, `parseOperations`). Keep: package doc (append one sentence: "The jj mechanics live in pkg/jj, shared with the repository dock's wshrpc commands."), `errResult`, `okResult`, `pathArgs`, `schemaPathOnly`, `extractPath`, `init()` registration blocks (change the gate to `if !jj.Available() {`). Import `"github.com/wavetermdev/waveterm/pkg/jj"`; drop now-unused imports (`os`, `os/exec`, `path/filepath`, `time`, `strings` — keep `strings` only if still used).

New handler bodies (payloads byte-identical to today):

```go
func handleInit(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args pathArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := jj.ResolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	colocated, already, err := jj.Init(ctx, dir)
	if err != nil {
		return errResult(err), nil
	}
	if already {
		return okResult(map[string]any{
			"path": dir, "already_initialized": true,
			"note": "workspace is already tracked; nothing changed",
		})
	}
	return okResult(map[string]any{
		"path": dir, "colocated": colocated, "remote": nil,
		"note": "local repository created with no remote; nothing is sent anywhere",
	})
}

func handleStatus(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args pathArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := jj.ResolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	text, clean, err := jj.StatusText(ctx, dir)
	if err != nil {
		return errResult(err), nil
	}
	out, clipped := jj.Truncate(text)
	return okResult(map[string]any{
		"path": dir, "status": out, "truncated": clipped,
		"clean": clean,
	})
}

func handleCheckpoint(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Path  string `json:"path"`
		Label string `json:"label"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := jj.ResolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	opID, err := jj.CheckpointID(ctx, dir)
	if err != nil {
		return errResult(err), nil
	}
	return okResult(map[string]any{
		"path": dir, "operation": opID, "label": args.Label,
		"restore_with": "vcs.undo",
		"note":         "pass this operation id to vcs.undo to restore the tree to this moment",
	})
}

func handleDiff(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Path     string `json:"path"`
		Revision string `json:"revision"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := jj.ResolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	diff, err := jj.DiffText(ctx, dir, args.Revision)
	if err != nil {
		return errResult(err), nil
	}
	text, clipped := jj.Truncate(diff)
	return okResult(map[string]any{
		"path": dir, "revision": args.Revision, "diff": text,
		"truncated": clipped, "empty": strings.TrimSpace(diff) == "",
	})
}

func handleHistory(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Path  string `json:"path"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := jj.ResolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	limit := jj.ClampLimit(args.Limit)
	ops, err := jj.History(ctx, dir, limit)
	if err != nil {
		return errResult(err), nil
	}
	return okResult(map[string]any{
		"path": dir, "operations": ops, "limit": limit,
	})
}

func handleUndo(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Path      string `json:"path"`
		Operation string `json:"operation"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := jj.ResolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	op := strings.TrimSpace(args.Operation)
	var detail string
	mode := "last-operation"
	if op == "" {
		detail, err = jj.Undo(ctx, dir)
	} else {
		mode = "restore-to-operation"
		detail, err = jj.Restore(ctx, dir, op)
	}
	if err != nil {
		return errResult(err), nil
	}
	text, clipped := jj.Truncate(detail)
	return okResult(map[string]any{
		"path": dir, "mode": mode, "operation": op,
		"result": text, "truncated": clipped,
	})
}
```

- [ ] **Step 4: Re-point the agent tests' stub seam**

In `pkg/agent/tools/vcs/vcs_test.go`: add import `"github.com/wavetermdev/waveterm/pkg/jj"`; in `TestArgumentsAreNotShellInterpreted`, `TestHistoryClampsLimit`, and `TestUndoWithoutOperationUndoesOnlyTheLastOne`, replace each

```go
restore := runJJ
runJJ = func(...) ...
defer func() { runJJ = restore }()
```

with

```go
restore := jj.Run
jj.Run = func(_ context.Context, _ string, args ...string) (string, string, error) {
	captured = args
	return "", "", nil
}
defer func() { jj.Run = restore }()
```

(keep each test's original return values — the undo test returns `"", "done", nil`). `TestParseOperations` was moved in Step 2; delete it here. Everything else (path validation, mutability table, both real-jj e2e tests) stays untouched.

- [ ] **Step 5: Run the full guard**

Run: `cd /Users/crowelogic/Projects/hypheus && go test ./pkg/jj/... ./pkg/agent/tools/vcs/...`
Expected: PASS, including `TestCheckpointSurvivesAWreckedTree` against real jj.

- [ ] **Step 6: Commit**

```bash
cd /Users/crowelogic/Projects/hypheus
git add pkg/jj/ pkg/agent/tools/vcs/
git commit -m "refactor(vcs): extract the jj core into pkg/jj, shared with the coming dock RPCs"
```

---

### Task 2: New core capabilities in `pkg/jj`

**Files:**
- Modify: `pkg/jj/jj.go`
- Modify: `pkg/jj/jj_test.go`

**Interfaces:**
- Consumes: `Run`, `FirstLine`, `ErrNotRepo` seams from Task 1.
- Produces (Task 3 depends on these):
  - `jj.ErrNotRepo` (sentinel `error`)
  - `jj.WorkspaceRoot(ctx, dir) (string, error)` — returns `ErrNotRepo` when the directory is not tracked
  - `jj.FileChange{Path string; Changes int; Plus int; Minus int}`
  - `jj.DiffStat(ctx, dir) ([]FileChange, error)` — working copy vs parent commit
  - `jj.OpFiles(ctx, dir, opID string) ([]FileChange, error)` — files changed by one operation

- [ ] **Step 1: Write the failing tests**

Append to `pkg/jj/jj_test.go` (add imports `errors` if missing):

```go
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
// not match.
func TestParseStatLinesAggregatesOpShowOutput(t *testing.T) {
	out := "f0302bfacf0f user@host now, lasted 9 milliseconds\n" +
		"snapshot working copy\n" +
		"args: jj status\n" +
		"\n" +
		"Changed commits:\n" +
		"○  + qwnuyzlk 911b2a12 (no description set)\n" +
		"   a.txt | 1 +\n" +
		"   b.txt | 2 ++\n" +
		"   2 files changed, 3 insertions(+), 0 deletions(-)\n" +
		"   a.txt | 1 -\n"
	files := parseStatLines(out)
	if len(files) != 2 {
		t.Fatalf("got %d files, want 2: %+v", len(files), files)
	}
	if files[0] != (FileChange{Path: "a.txt", Changes: 2, Plus: 1, Minus: 1}) {
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
```

Also add to `TestParseOperations`-adjacent coverage a not-a-repo detection guard against the exact live error text (already covered by `TestWorkspaceRootNotARepo` fixture, which uses the string verified on jj 0.44: `Error: There is no jj repo in "."`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd /Users/crowelogic/Projects/hypheus && go test ./pkg/jj/ -run 'WorkspaceRoot|ParseStat|RealRepo' -v`
Expected: FAIL with undefined: `WorkspaceRoot`, `parseStatLines`, `FileChange`, `DiffStat`, `OpFiles`, `ErrNotRepo`.

- [ ] **Step 3: Implement**

Append to `pkg/jj/jj.go` (add imports `errors`, `regexp`, `strconv`):

```go
// ErrNotRepo distinguishes "this directory is simply not tracked" — a normal
// state the dock offers to fix — from real failures.
var ErrNotRepo = errors.New("not a jj repository")

func WorkspaceRoot(ctx context.Context, dir string) (string, error) {
	stdout, stderr, err := Run(ctx, dir, "workspace", "root")
	if err != nil {
		if strings.Contains(stderr, "no jj repo") {
			return "", ErrNotRepo
		}
		return "", fmt.Errorf("jj workspace root failed: %s", FirstLine(stderr, err))
	}
	return strings.TrimSpace(stdout), nil
}

type FileChange struct {
	Path    string
	Changes int
	Plus    int
	Minus   int
}

// statLineRe matches git-style stat lines: "path | 3 ++-". The +/- bar is
// proportional (scaled down on very large diffs), so Plus/Minus are honest
// approximations, not guaranteed insert/delete counts.
var statLineRe = regexp.MustCompile(`^\s*(.+?)\s+\|\s+(\d+)\s*([+-]*)\s*$`)

func parseStatLines(out string) []FileChange {
	files := []FileChange{}
	index := map[string]int{}
	for _, line := range strings.Split(out, "\n") {
		m := statLineRe.FindStringSubmatch(line)
		if m == nil {
			continue
		}
		n, _ := strconv.Atoi(m[2])
		plus := strings.Count(m[3], "+")
		minus := strings.Count(m[3], "-")
		if i, ok := index[m[1]]; ok {
			files[i].Changes += n
			files[i].Plus += plus
			files[i].Minus += minus
			continue
		}
		index[m[1]] = len(files)
		files = append(files, FileChange{Path: m[1], Changes: n, Plus: plus, Minus: minus})
	}
	return files
}

func DiffStat(ctx context.Context, dir string) ([]FileChange, error) {
	stdout, stderr, err := Run(ctx, dir, "diff", "--stat")
	if err != nil {
		return nil, fmt.Errorf("jj diff failed: %s", FirstLine(stderr, err))
	}
	return parseStatLines(stdout), nil
}

func OpFiles(ctx context.Context, dir string, opID string) ([]FileChange, error) {
	op := strings.TrimSpace(opID)
	if op == "" {
		return nil, fmt.Errorf("operation id required")
	}
	stdout, stderr, err := Run(ctx, dir, "op", "show", op, "--stat")
	if err != nil {
		return nil, fmt.Errorf("jj op show failed: %s", FirstLine(stderr, err))
	}
	return parseStatLines(stdout), nil
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd /Users/crowelogic/Projects/hypheus && go test ./pkg/jj/...`
Expected: PASS (the real-repo test exercises jj 0.44 end to end).

- [ ] **Step 5: Commit**

```bash
cd /Users/crowelogic/Projects/hypheus
git add pkg/jj/
git commit -m "feat(jj): workspace root, diff stat, and per-operation file parsing"
```

---

### Task 3: The five vcs wshrpc commands

**Files:**
- Modify: `pkg/wshrpc/wshrpctypes.go`
- Modify: `pkg/wshrpc/wshserver/wshserver.go`
- Create: `pkg/wshrpc/wshserver/wshserver_vcs_test.go`
- Generated (by `task generate`, commit but never hand-edit): `frontend/types/gotypes.d.ts`, `frontend/app/store/wshclientapi.ts`, plus any other files generate touches under `pkg/wshrpc/`

**Interfaces:**
- Consumes: everything `pkg/jj` produces (Tasks 1–2), `wavebase.GetHomeDir()`, `wavebase.ExpandHomeDir(string) (string, error)`.
- Produces (Task 4's frontend calls these; TS names are the generated lowercase JSON fields):
  - `RpcApi.VcsStatusCommand(TabRpcClient, {path}) → {installed, isrepo, dir, root, clean, files}`
  - `RpcApi.VcsHistoryCommand(TabRpcClient, {path, limit}) → {operations: [{opid, description, time, timerel}]}`
  - `RpcApi.VcsOpFilesCommand(TabRpcClient, {path, operation}) → {files: [{path, changes, plus, minus}]}`
  - `RpcApi.VcsRestoreCommand(TabRpcClient, {path, operation}) → {detail}` (empty operation = undo last)
  - `RpcApi.VcsInitCommand(TabRpcClient, {path}) → {colocated, alreadyinitialized}`

- [ ] **Step 1: Define the interface methods and types in `pkg/wshrpc/wshrpctypes.go`**

Add to `WshRpcInterface` (near the other command groups, as a `// vcs (repository dock)` section):

```go
	VcsStatusCommand(ctx context.Context, data CommandVcsStatusData) (*CommandVcsStatusRtnData, error)
	VcsHistoryCommand(ctx context.Context, data CommandVcsHistoryData) (*CommandVcsHistoryRtnData, error)
	VcsOpFilesCommand(ctx context.Context, data CommandVcsOpFilesData) (*CommandVcsOpFilesRtnData, error)
	VcsRestoreCommand(ctx context.Context, data CommandVcsRestoreData) (*CommandVcsRestoreRtnData, error)
	VcsInitCommand(ctx context.Context, data CommandVcsInitData) (*CommandVcsInitRtnData, error)
```

And the types (with the other type definitions):

```go
type CommandVcsStatusData struct {
	Path string `json:"path,omitempty"`
}

type VcsFileChange struct {
	Path    string `json:"path"`
	Changes int    `json:"changes"`
	Plus    int    `json:"plus"`
	Minus   int    `json:"minus"`
}

type CommandVcsStatusRtnData struct {
	Installed bool            `json:"installed"`
	IsRepo    bool            `json:"isrepo"`
	Dir       string          `json:"dir,omitempty"`
	Root      string          `json:"root,omitempty"`
	Clean     bool            `json:"clean"`
	Files     []VcsFileChange `json:"files,omitempty"`
}

type CommandVcsHistoryData struct {
	Path  string `json:"path,omitempty"`
	Limit int    `json:"limit,omitempty"`
}

type VcsOperation struct {
	OpId        string `json:"opid"`
	Description string `json:"description"`
	Time        string `json:"time"`
	TimeRel     string `json:"timerel"`
}

type CommandVcsHistoryRtnData struct {
	Operations []VcsOperation `json:"operations,omitempty"`
}

type CommandVcsOpFilesData struct {
	Path      string `json:"path,omitempty"`
	Operation string `json:"operation"`
}

type CommandVcsOpFilesRtnData struct {
	Files []VcsFileChange `json:"files,omitempty"`
}

type CommandVcsRestoreData struct {
	Path      string `json:"path,omitempty"`
	Operation string `json:"operation,omitempty"`
}

type CommandVcsRestoreRtnData struct {
	Detail string `json:"detail,omitempty"`
}

type CommandVcsInitData struct {
	Path string `json:"path,omitempty"`
}

type CommandVcsInitRtnData struct {
	Colocated          bool `json:"colocated,omitempty"`
	AlreadyInitialized bool `json:"alreadyinitialized,omitempty"`
}
```

- [ ] **Step 2: Generate bindings**

Run: `cd /Users/crowelogic/Projects/hypheus && task generate`
Expected: exits 0; `git diff --stat` shows `frontend/types/gotypes.d.ts` and `frontend/app/store/wshclientapi.ts` gained Vcs entries. If generation fails, re-check the signatures against the add-rpc skill rules (name ends with Command, ctx first, one return + error).

- [ ] **Step 3: Write the failing handler tests**

Create `pkg/wshrpc/wshserver/wshserver_vcs_test.go` (mirrors the bare `&WshServer{}` pattern of `wshserver_crowecode_test.go`):

```go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/jj"
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
```

Run: `cd /Users/crowelogic/Projects/hypheus && go test ./pkg/wshrpc/wshserver/ -run Vcs -v`
Expected: FAIL with undefined `VcsStatusCommand` etc.

- [ ] **Step 4: Implement the handlers in `pkg/wshrpc/wshserver/wshserver.go`**

Add imports `"errors"` and `"github.com/wavetermdev/waveterm/pkg/jj"` if missing (`wavebase` is already imported). Append:

```go
// resolveVcsDir applies the panel's targeting rule server-side: an empty path
// falls back to the home directory, and validation reuses the same refusal
// list the agent tools enforce.
func resolveVcsDir(rawPath string) (string, error) {
	p := strings.TrimSpace(rawPath)
	if p == "" {
		p = wavebase.GetHomeDir()
	}
	expanded, err := wavebase.ExpandHomeDir(p)
	if err != nil {
		return "", err
	}
	return jj.ResolveDir(expanded)
}

func vcsFileChanges(changes []jj.FileChange) []wshrpc.VcsFileChange {
	rtn := make([]wshrpc.VcsFileChange, 0, len(changes))
	for _, c := range changes {
		rtn = append(rtn, wshrpc.VcsFileChange{Path: c.Path, Changes: c.Changes, Plus: c.Plus, Minus: c.Minus})
	}
	return rtn
}

func (ws *WshServer) VcsStatusCommand(ctx context.Context, data wshrpc.CommandVcsStatusData) (*wshrpc.CommandVcsStatusRtnData, error) {
	if !jj.Available() {
		return &wshrpc.CommandVcsStatusRtnData{}, nil
	}
	dir, err := resolveVcsDir(data.Path)
	if err != nil {
		return nil, err
	}
	root, err := jj.WorkspaceRoot(ctx, dir)
	if errors.Is(err, jj.ErrNotRepo) {
		return &wshrpc.CommandVcsStatusRtnData{Installed: true, Dir: dir}, nil
	}
	if err != nil {
		return nil, err
	}
	// jj status also snapshots the working copy, so polling this command is
	// what keeps the agent's edits continuously restorable.
	_, clean, err := jj.StatusText(ctx, dir)
	if err != nil {
		return nil, err
	}
	rtn := &wshrpc.CommandVcsStatusRtnData{Installed: true, IsRepo: true, Dir: dir, Root: root, Clean: clean}
	if clean {
		return rtn, nil
	}
	changes, err := jj.DiffStat(ctx, dir)
	if err != nil {
		return nil, err
	}
	rtn.Files = vcsFileChanges(changes)
	return rtn, nil
}

func (ws *WshServer) VcsHistoryCommand(ctx context.Context, data wshrpc.CommandVcsHistoryData) (*wshrpc.CommandVcsHistoryRtnData, error) {
	if !jj.Available() {
		return nil, fmt.Errorf("jj is not installed")
	}
	dir, err := resolveVcsDir(data.Path)
	if err != nil {
		return nil, err
	}
	ops, err := jj.History(ctx, dir, data.Limit)
	if err != nil {
		return nil, err
	}
	rtn := &wshrpc.CommandVcsHistoryRtnData{Operations: make([]wshrpc.VcsOperation, 0, len(ops))}
	for _, op := range ops {
		rtn.Operations = append(rtn.Operations, wshrpc.VcsOperation{
			OpId: op.ID, Description: op.Description, Time: op.Time, TimeRel: op.TimeRel,
		})
	}
	return rtn, nil
}

func (ws *WshServer) VcsOpFilesCommand(ctx context.Context, data wshrpc.CommandVcsOpFilesData) (*wshrpc.CommandVcsOpFilesRtnData, error) {
	if !jj.Available() {
		return nil, fmt.Errorf("jj is not installed")
	}
	if strings.TrimSpace(data.Operation) == "" {
		return nil, fmt.Errorf("operation is required")
	}
	dir, err := resolveVcsDir(data.Path)
	if err != nil {
		return nil, err
	}
	files, err := jj.OpFiles(ctx, dir, data.Operation)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandVcsOpFilesRtnData{Files: vcsFileChanges(files)}, nil
}

func (ws *WshServer) VcsRestoreCommand(ctx context.Context, data wshrpc.CommandVcsRestoreData) (*wshrpc.CommandVcsRestoreRtnData, error) {
	if !jj.Available() {
		return nil, fmt.Errorf("jj is not installed")
	}
	dir, err := resolveVcsDir(data.Path)
	if err != nil {
		return nil, err
	}
	op := strings.TrimSpace(data.Operation)
	var detail string
	if op == "" {
		detail, err = jj.Undo(ctx, dir)
	} else {
		detail, err = jj.Restore(ctx, dir, op)
	}
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandVcsRestoreRtnData{Detail: detail}, nil
}

func (ws *WshServer) VcsInitCommand(ctx context.Context, data wshrpc.CommandVcsInitData) (*wshrpc.CommandVcsInitRtnData, error) {
	if !jj.Available() {
		return nil, fmt.Errorf("jj is not installed")
	}
	dir, err := resolveVcsDir(data.Path)
	if err != nil {
		return nil, err
	}
	colocated, already, err := jj.Init(ctx, dir)
	if err != nil {
		return nil, err
	}
	return &wshrpc.CommandVcsInitRtnData{Colocated: colocated, AlreadyInitialized: already}, nil
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `cd /Users/crowelogic/Projects/hypheus && go test ./pkg/wshrpc/... ./pkg/jj/... ./pkg/agent/tools/vcs/...`
Expected: PASS.

- [ ] **Step 6: Commit**

Stage exactly the edited and generated files (check `git status --short` first; do not sweep in the dock migration or `package-lock.json`):

```bash
cd /Users/crowelogic/Projects/hypheus
git add pkg/wshrpc/ frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
git commit -m "feat(wshrpc): vcs commands for the repository dock"
```

If `task generate` touched additional generated files (visible in `git status`), add those too — generated deltas belong with the types that produced them.

---

### Task 4: Frontend model and tool id

**Files:**
- Modify: `frontend/app/dock/dock-model.ts:7` (the `DockToolId` union)
- Create: `frontend/app/dock/vcs-model.ts`

**Interfaces:**
- Consumes: the five generated `RpcApi.Vcs*Command` clients (Task 3), `DockModel` atoms, `getFocusedBlockId` from `@/app/store/global`, block meta key `cmd:cwd` (the same key `term-model.ts:962` reads).
- Produces (Task 5 depends on these):
  - `DockToolId` includes `"repo"`
  - `VcsModel.getInstance()` with: `statusAtom`, `historyAtom`, `expandedOpAtom`, `opFilesAtom`, `busyAtom`, `errorAtom`, `dirtyAtom`; methods `refresh(includeHistory?)`, `startPolling()`, `toggleOp(opId)`, `restoreTo(opId?)`, `initRepo()`; static `fetchDisabled`

- [ ] **Step 1: Gate on the parallel session's dock work**

Run: `cd /Users/crowelogic/Projects/hypheus && git status --short frontend/app/dock/ frontend/app/workspace/workspace.tsx frontend/wave.ts`

If `utilitydock.tsx`, `dock.scss`, `dock-model.ts`, or `crowe-icons.tsx` show uncommitted modifications, **STOP and ask Michael** whether the left-dock migration should be committed first (recommended, as its own commit, so the VCS panel changes stay reviewable on their own). Do not proceed to edit those files while the question is open. `vcs-model.ts` is a new file and may be written regardless.

- [ ] **Step 2: Extend the tool id union**

In `frontend/app/dock/dock-model.ts` line 7:

```ts
export type DockToolId = "telemetry" | "model" | "thinking" | "design" | "mycelium" | "repo";
```

- [ ] **Step 3: Create `frontend/app/dock/vcs-model.ts`**

```ts
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { getFocusedBlockId } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import * as jotai from "jotai";
import { DockModel } from "./dock-model";

const PollIntervalMs = 10_000;
const HistoryLimit = 30;

export class VcsModel {
    private static instance: VcsModel | null = null;
    // Previews seed atoms directly and have no wavesrv to answer RPCs;
    // fetching there would clobber the seeded state with errors.
    static fetchDisabled = false;

    statusAtom = jotai.atom(null) as jotai.PrimitiveAtom<CommandVcsStatusRtnData>;
    historyAtom = jotai.atom([]) as jotai.PrimitiveAtom<VcsOperation[]>;
    expandedOpAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    opFilesAtom = jotai.atom({}) as jotai.PrimitiveAtom<Record<string, VcsFileChange[]>>;
    busyAtom = jotai.atom(false);
    errorAtom = jotai.atom(null) as jotai.PrimitiveAtom<string>;
    dirtyAtom!: jotai.Atom<boolean>;

    private pollTimer: ReturnType<typeof setInterval> = null;

    private constructor() {
        this.dirtyAtom = jotai.atom((get) => {
            const s = get(this.statusAtom);
            return !!s?.installed && !!s?.isrepo && !s.clean;
        });
    }

    static getInstance(): VcsModel {
        if (!VcsModel.instance) {
            VcsModel.instance = new VcsModel();
        }
        return VcsModel.instance;
    }

    // The active block's cwd, falling back to empty, which the server resolves
    // to the home directory. Same meta key the terminal itself trusts.
    targetDir(): string {
        const blockId = getFocusedBlockId();
        if (!blockId) {
            return "";
        }
        const block = globalStore.get(WOS.getWaveObjectAtom<Block>(WOS.makeORef("block", blockId)));
        return block?.meta?.["cmd:cwd"] ?? "";
    }

    private panelOpen(): boolean {
        const dock = DockModel.getInstance();
        return globalStore.get(dock.activeToolAtom) === "repo" && !globalStore.get(dock.collapsedAtom);
    }

    async refresh(includeHistory?: boolean) {
        if (VcsModel.fetchDisabled) {
            return;
        }
        const path = this.targetDir();
        try {
            const status = await RpcApi.VcsStatusCommand(TabRpcClient, { path });
            globalStore.set(this.statusAtom, status);
            if ((includeHistory ?? this.panelOpen()) && status?.isrepo) {
                const hist = await RpcApi.VcsHistoryCommand(TabRpcClient, { path, limit: HistoryLimit });
                globalStore.set(this.historyAtom, hist?.operations ?? []);
            }
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            globalStore.set(this.errorAtom, String(e));
        }
    }

    // Runs for the life of the app so the rail pip stays honest while the
    // panel is closed; history is only fetched while the panel is open.
    startPolling() {
        if (this.pollTimer != null) {
            return;
        }
        this.refresh();
        this.pollTimer = setInterval(() => this.refresh(), PollIntervalMs);
    }

    async toggleOp(opId: string) {
        if (globalStore.get(this.expandedOpAtom) === opId) {
            globalStore.set(this.expandedOpAtom, null);
            return;
        }
        globalStore.set(this.expandedOpAtom, opId);
        if (globalStore.get(this.opFilesAtom)[opId] != null || VcsModel.fetchDisabled) {
            return;
        }
        try {
            const rtn = await RpcApi.VcsOpFilesCommand(TabRpcClient, { path: this.targetDir(), operation: opId });
            globalStore.set(this.opFilesAtom, { ...globalStore.get(this.opFilesAtom), [opId]: rtn?.files ?? [] });
        } catch (e) {
            globalStore.set(this.errorAtom, String(e));
        }
    }

    // The panel's only mutating action. jj's own message comes back verbatim
    // on failure; paraphrasing loses information exactly when it matters.
    async restoreTo(opId?: string) {
        if (globalStore.get(this.busyAtom)) {
            return;
        }
        globalStore.set(this.busyAtom, true);
        try {
            await RpcApi.VcsRestoreCommand(TabRpcClient, { path: this.targetDir(), operation: opId ?? "" });
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            globalStore.set(this.errorAtom, String(e));
        } finally {
            globalStore.set(this.busyAtom, false);
            globalStore.set(this.opFilesAtom, {});
            this.refresh(true);
        }
    }

    async initRepo() {
        if (globalStore.get(this.busyAtom)) {
            return;
        }
        globalStore.set(this.busyAtom, true);
        try {
            await RpcApi.VcsInitCommand(TabRpcClient, { path: this.targetDir() });
            globalStore.set(this.errorAtom, null);
        } catch (e) {
            globalStore.set(this.errorAtom, String(e));
        } finally {
            globalStore.set(this.busyAtom, false);
            this.refresh(true);
        }
    }
}
```

(`CommandVcsStatusRtnData`, `VcsOperation`, `VcsFileChange`, and `Block` are ambient types from the generated `gotypes.d.ts` — no import needed, same as `Block` in `dockpanels.tsx`.)

- [ ] **Step 4: Verify types**

Confirm the editor shows no TS diagnostics in `vcs-model.ts` and `dock-model.ts` (the repo relies on editor diagnostics; there is no standalone typecheck script). Then run the frontend test suite to prove nothing regressed: `npx vitest run` — Expected: PASS.

- [ ] **Step 5: Commit**

```bash
cd /Users/crowelogic/Projects/hypheus
git add frontend/app/dock/vcs-model.ts frontend/app/dock/dock-model.ts
git commit -m "feat(dock): vcs model and repo tool id"
```

(Only safe if Step 1's gate was resolved; `dock-model.ts` must contain no left-dock changes beyond yours — check `git diff --cached` before committing.)

---

### Task 5: The panel, the icon, the pip, the rail entry

**Files:**
- Modify: `frontend/app/dock/crowe-icons.tsx` (append one icon)
- Modify: `frontend/app/dock/dockpanels.tsx` (append the panel section)
- Modify: `frontend/app/dock/utilitydock.tsx` (imports, one `DOCK_TOOLS` entry, pip component + render, one `useEffect`)
- Modify: `frontend/app/dock/dock.scss` (append styles)

**Interfaces:**
- Consumes: `VcsModel` (Task 4), `DockToolId "repo"`, existing classes `crowe-panel`, `crowe-panel-hint`, `crowe-empty`, `crowe-btn`, `crowe-link`, `cn`, the `DesignBadge` badge-rendering pattern at `utilitydock.tsx:241`.
- Produces: `RingsIcon` (crowe-icons), `VcsPanel` (dockpanels export), `crowe-dock-pip` / `crowe-vcs-*` styles.

- [ ] **Step 1: Add the icon to `frontend/app/dock/crowe-icons.tsx`**

Growth rings — layered history in the file's organic language (24x24, currentColor stroke, matching `svgProps`):

```tsx
export const RingsIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <path d="M12 21a9 9 0 1 1 9-9" />
        <path d="M12 17.5a5.5 5.5 0 1 1 5.5-5.5" />
        <circle cx="12" cy="12" r="1.8" />
    </svg>
);
```

- [ ] **Step 2: Append the panel to `frontend/app/dock/dockpanels.tsx`**

Add imports at the top: `VcsModel` from `./vcs-model` (and note `useEffect`, `useAtomValue`, `cn` are already imported). Append:

```tsx
// --- Repository (jj operation log) -----------------------------------------

const VcsFileRow = ({ file }: { file: VcsFileChange }) => (
    <div className="crowe-vcs-file">
        <span className="crowe-vcs-file-path" title={file.path}>
            {file.path}
        </span>
        <span className="crowe-vcs-counts">
            {file.plus > 0 && <span className="crowe-vcs-plus">+{file.plus}</span>}
            {file.minus > 0 && <span className="crowe-vcs-minus">-{file.minus}</span>}
            {file.plus === 0 && file.minus === 0 && <span>{file.changes}</span>}
        </span>
    </div>
);

const VcsOpRow = ({ op }: { op: VcsOperation }) => {
    const m = VcsModel.getInstance();
    const expandedOp = useAtomValue(m.expandedOpAtom);
    const opFiles = useAtomValue(m.opFilesAtom);
    const busy = useAtomValue(m.busyAtom);
    const expanded = expandedOp === op.opid;
    const files = opFiles[op.opid];
    return (
        <div className={cn("crowe-vcs-op", expanded && "crowe-vcs-op-expanded")}>
            <button
                type="button"
                className="crowe-vcs-op-head cursor-pointer"
                onClick={() => m.toggleOp(op.opid)}
                aria-expanded={expanded}
            >
                <span className="crowe-vcs-op-desc" title={op.description}>
                    {op.description || "(no description)"}
                </span>
                <span className="crowe-vcs-op-time">{op.timerel}</span>
            </button>
            {expanded && (
                <div className="crowe-vcs-op-body">
                    {files == null && <div className="crowe-panel-hint">Reading files</div>}
                    {files != null && files.length === 0 && (
                        <div className="crowe-panel-hint">No file changes in this operation.</div>
                    )}
                    {files?.map((f) => (
                        <VcsFileRow key={f.path} file={f} />
                    ))}
                    <button
                        type="button"
                        className="crowe-btn cursor-pointer"
                        disabled={busy}
                        onClick={() => m.restoreTo(op.opid)}
                    >
                        Restore to here
                    </button>
                </div>
            )}
        </div>
    );
};

export const VcsPanel = () => {
    const m = VcsModel.getInstance();
    const status = useAtomValue(m.statusAtom);
    const history = useAtomValue(m.historyAtom);
    const busy = useAtomValue(m.busyAtom);
    const error = useAtomValue(m.errorAtom);

    useEffect(() => {
        m.refresh(true);
    }, []);

    if (status == null) {
        return <div className="crowe-empty">Reading repository state.</div>;
    }
    if (!status.installed) {
        return (
            <div className="crowe-panel">
                <div className="crowe-empty">Jujutsu (jj) is not installed, so there is no operation log to show.</div>
            </div>
        );
    }
    if (!status.isrepo) {
        return (
            <div className="crowe-panel">
                <div className="crowe-vcs-dir" title={status.dir}>
                    {status.dir}
                </div>
                <div className="crowe-empty">This directory is not tracked yet.</div>
                <button type="button" className="crowe-btn cursor-pointer" disabled={busy} onClick={() => m.initRepo()}>
                    Start tracking this directory
                </button>
                <div className="crowe-panel-hint">
                    Creates a self-contained local repository with no remote. Nothing is sent anywhere.
                </div>
            </div>
        );
    }
    const fileCount = status.files?.length ?? 0;
    return (
        <div className="crowe-panel">
            <div className="crowe-vcs-dir" title={status.root || status.dir}>
                {status.root || status.dir}
            </div>
            {error && <div className="crowe-vcs-error">{error}</div>}
            <div className={cn("crowe-vcs-now", !status.clean && "crowe-vcs-now-dirty")}>
                <div className="crowe-vcs-now-head">
                    <span className="crowe-vcs-now-label">Now</span>
                    <span className="crowe-vcs-now-summary">
                        {status.clean ? "no uncommitted changes" : `${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
                    </span>
                    {!status.clean && (
                        <button
                            type="button"
                            className="crowe-link cursor-pointer"
                            disabled={busy}
                            onClick={() => m.restoreTo()}
                        >
                            undo last
                        </button>
                    )}
                </div>
                {status.files?.map((f) => (
                    <VcsFileRow key={f.path} file={f} />
                ))}
            </div>
            {history.length === 0 ? (
                <div className="crowe-empty">No operations recorded yet.</div>
            ) : (
                history.map((op) => <VcsOpRow key={op.opid} op={op} />)
            )}
            <div className="crowe-panel-hint">Every restore is itself an operation, so a restore can always be restored.</div>
        </div>
    );
};
```

- [ ] **Step 3: Register the tool in `frontend/app/dock/utilitydock.tsx`**

Four additive edits, layered on top of the in-flight left-dock changes without touching them:

1. Extend the icon import from `./crowe-icons` with `RingsIcon`, the panel import from `./dockpanels` with `VcsPanel`, and add `import { VcsModel } from "./vcs-model";`.
2. Append to `DOCK_TOOLS`:

```tsx
    { id: "repo", label: "Repository", Icon: RingsIcon, Panel: VcsPanel },
```

3. Next to `DesignBadge` (around line 45), add:

```tsx
const VcsDirtyPip = memo(() => {
    const dirty = useAtomValue(VcsModel.getInstance().dirtyAtom);
    if (!dirty) {
        return null;
    }
    return <span className="crowe-dock-pip" />;
});
VcsDirtyPip.displayName = "VcsDirtyPip";
```

and in the tool-button loop, directly under `{tool.id === "design" && <DesignBadge />}` (line ~241):

```tsx
                            {tool.id === "repo" && <VcsDirtyPip />}
```

4. In `UtilityDockElem`, add a mount effect (with the other hooks, before any conditional):

```tsx
    useEffect(() => {
        VcsModel.getInstance().startPolling();
    }, []);
```

- [ ] **Step 4: Append styles to `frontend/app/dock/dock.scss`**

Tokens verified in this tree: `--crowe-gold: #bfa669` (crowe-tokens.css:27), `--crowe-gold-25`, `--crowe-error` (what `.crowe-link-danger` uses, dock.scss:670), `--glass-hairline-chrome`.

```scss
// Repository panel + rail pip. The pip is the whole ticker: gold means the
// tree has uncommitted changes.
.crowe-dock-pip {
    position: absolute;
    top: 5px;
    right: 5px;
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--crowe-gold);
    box-shadow: 0 0 6px var(--crowe-gold-25);
    pointer-events: none;
}

.crowe-vcs-dir {
    font-family: var(--fixed-font, monospace);
    font-size: 11px;
    color: var(--secondary-text-color);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
}

.crowe-vcs-error {
    font-size: 11px;
    color: var(--crowe-error);
    border-left: 2px solid var(--crowe-error);
    padding: 4px 8px;
    word-break: break-word;
}

.crowe-vcs-now {
    border: 1px solid var(--glass-hairline-chrome);
    border-radius: 4px;
    padding: 8px;
    display: flex;
    flex-direction: column;
    gap: 4px;

    &.crowe-vcs-now-dirty {
        border-color: var(--crowe-gold-25);
    }
}

.crowe-vcs-now-head {
    display: flex;
    align-items: center;
    gap: 8px;

    .crowe-vcs-now-label {
        font-size: 10px;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        color: var(--crowe-gold);
    }

    .crowe-vcs-now-summary {
        flex: 1 1 auto;
        min-width: 0;
        font-size: 12px;
    }
}

.crowe-vcs-op {
    border-bottom: 1px solid var(--glass-hairline-chrome);

    .crowe-vcs-op-head {
        display: flex;
        width: 100%;
        align-items: baseline;
        gap: 8px;
        padding: 6px 2px;
        background: none;
        border: none;
        color: inherit;
        text-align: left;
        font-size: 12px;
    }

    .crowe-vcs-op-desc {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }

    .crowe-vcs-op-time {
        flex-shrink: 0;
        font-size: 11px;
        color: var(--secondary-text-color);
    }

    .crowe-vcs-op-body {
        display: flex;
        flex-direction: column;
        gap: 4px;
        padding: 0 2px 8px;
    }
}

.crowe-vcs-file {
    display: flex;
    align-items: baseline;
    gap: 8px;
    font-family: var(--fixed-font, monospace);
    font-size: 11px;

    .crowe-vcs-file-path {
        flex: 1 1 auto;
        min-width: 0;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        direction: rtl;
        text-align: left;
    }

    .crowe-vcs-counts {
        flex-shrink: 0;
        display: flex;
        gap: 6px;
    }

    .crowe-vcs-plus {
        color: var(--crowe-gold);
    }

    .crowe-vcs-minus {
        color: var(--crowe-error);
    }
}
```

(If `--secondary-text-color` or `--fixed-font` do not exist in this tree, open `frontend/app/theme.scss` lines 1-120 and substitute the muted-text and monospace tokens defined there — those two names are the upstream Wave defaults and are the only unverified tokens in this block.)

- [ ] **Step 5: Verify**

Editor shows no TS/SCSS diagnostics in the four files. Run `npx vitest run` — Expected: PASS.

- [ ] **Step 6: Commit — with the mixed-file caveat**

`utilitydock.tsx`, `dock.scss`, and `crowe-icons.tsx` will contain both the left-dock migration and your additions unless the Task 4 Step 1 gate got the migration committed first. **Only commit these files if the gate was resolved** (migration committed, or Michael said to bundle). Then:

```bash
cd /Users/crowelogic/Projects/hypheus
git add frontend/app/dock/crowe-icons.tsx frontend/app/dock/dockpanels.tsx frontend/app/dock/utilitydock.tsx frontend/app/dock/dock.scss
git commit -m "feat(dock): repository panel with dirty pip and one-click restore"
```

---

### Task 6: Preview harness and final verification

**Files:**
- Create: `frontend/preview/previews/vcs.preview.tsx`

**Interfaces:**
- Consumes: `VcsPanel` (Task 5), `VcsModel` + `VcsModel.fetchDisabled` (Task 4), `globalStore`.

- [ ] **Step 1: Create `frontend/preview/previews/vcs.preview.tsx`**

Module-scope seeding matters: children's effects run before the parent's, so `fetchDisabled` must be set before `VcsPanel` ever mounts — at module top level, not in a `useEffect`.

```tsx
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { VcsPanel } from "@/app/dock/dockpanels";
import { VcsModel } from "@/app/dock/vcs-model";
import { globalStore } from "@/app/store/jotaiStore";

VcsModel.fetchDisabled = true;
const model = VcsModel.getInstance();
globalStore.set(model.statusAtom, {
    installed: true,
    isrepo: true,
    dir: "/Users/mike/Projects/hypheus",
    root: "/Users/mike/Projects/hypheus",
    clean: false,
    files: [
        { path: "frontend/app/dock/utilitydock.tsx", changes: 12, plus: 9, minus: 3 },
        { path: "pkg/jj/jj.go", changes: 4, plus: 4, minus: 0 },
    ],
});
globalStore.set(model.historyAtom, [
    { opid: "f0302bfacf0f", description: "snapshot working copy", time: "2026-08-09 07:05:33", timerel: "2 minutes ago" },
    { opid: "902af479a0b1", description: "snapshot working copy", time: "2026-08-09 06:51:10", timerel: "16 minutes ago" },
    { opid: "8c1d22aa90ef", description: "restore to operation 44f1", time: "2026-08-09 06:40:02", timerel: "27 minutes ago" },
    { opid: "44f19c0be2d1", description: "snapshot working copy", time: "2026-08-09 06:12:44", timerel: "55 minutes ago" },
]);
globalStore.set(model.opFilesAtom, {
    "902af479a0b1": [{ path: "frontend/app/dock/dock.scss", changes: 6, plus: 5, minus: 1 }],
});
globalStore.set(model.expandedOpAtom, "902af479a0b1");

export default function VcsPreview() {
    return (
        <div className="flex h-[640px] w-[360px] flex-col overflow-y-auto border border-border bg-background p-3 shadow-xl">
            <VcsPanel />
        </div>
    );
}
```

The frame is 360px wide on purpose — the spec's drawer constraint, rendered at exactly that width so layout problems show up here first.

- [ ] **Step 2: Full verification pass**

```bash
cd /Users/crowelogic/Projects/hypheus
go test ./pkg/jj/... ./pkg/agent/tools/vcs/... ./pkg/wshrpc/...
npx vitest run
task generate && git status --short frontend/types/gotypes.d.ts frontend/app/store/wshclientapi.ts
```

Expected: both suites PASS; `task generate` produces no new diff (idempotent — if it does, the previous run's output was not fully committed; commit the delta).

- [ ] **Step 3: Commit**

```bash
git add frontend/preview/previews/vcs.preview.tsx
git commit -m "feat(preview): vcs panel preview at drawer width"
```

- [ ] **Step 4 (optional, Michael-visible): live smoke against the dev instance**

The documented rail, with its traps: launches FULL SCREEN (warn Michael first), never `task dev:reset` (it kills the production app), kill dev only by path.

```bash
cd /Users/crowelogic/Projects/hypheus
CROWE_AGENT_PORT=8013 PYTHON=/opt/homebrew/bin/python3.13 npm_config_python=/opt/homebrew/bin/python3.13 task electron:quickdev
```

Check: rail shows the rings icon; opening it on a terminal block cd'd into a jj repo shows the Now row and history; a restore actually rewinds a scratch edit; the pip appears within ~10s of dirtying the tree.

---

## Self-review notes (done at plan time)

- **Spec coverage:** extraction → Task 1; new RPC surface → Task 3 (5 commands, deviation flagged); Now row / op list / inline files / pip → Task 5; data flow (mount + focus + post-restore refresh, polling) → Tasks 4-5 (poll always at 10s for the pip, history only while open — a deliberate strengthening of the spec's "poll while visible", since the spec's pip needs data while closed); error states (jj missing = plain message, not-a-repo = init offer, restore failure = verbatim jj message) → Tasks 3-5; scope exclusions respected (no commit/push/branch/merge/diff-view anywhere); tests move + handler tests + preview → Tasks 1, 3, 6; risk "which directory" → `crowe-vcs-dir` indicator + server-side home fallback.
- **Type consistency:** `opid`/`timerel`/`files`/`plus`/`minus` traced through Go tags → generated TS → panel props; `jj.Run`/`jj.LookPath` seam names identical across all three test files; `ClampLimit` used by both consumers.
- **Known approximations, stated in code comments:** stat-bar +/- counts are proportional on huge diffs; `restoreTo` refreshes even on failure (tree state may have changed partway).
