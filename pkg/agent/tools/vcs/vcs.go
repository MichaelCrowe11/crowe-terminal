// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package vcs gives the agent a local-first version control surface backed by
// Jujutsu (jj).
//
// The reason this exists rather than a thin `git` wrapper: jj snapshots the
// working copy automatically on every command, and records each snapshot in an
// operation log that can be restored atomically. That turns an agent editing a
// user's files from an irreversible act into a checkpointed transaction —
// vcs.checkpoint hands back an operation id, and vcs.undo rewinds the entire
// tree to it, restoring deleted files and discarding created ones in one step.
// Git has no equivalent; `git reset` cannot recover work that was never staged,
// and an agent that forgets to commit leaves nothing to recover.
//
// Repositories created here are local and remote-less on purpose: `jj git init`
// writes a self-contained store under .jj with no origin, so the workspace
// depends on no hosting provider. A remote can be added later by the user; the
// agent never adds one.
//
// Registration is gated on the jj binary being present, so on a machine without
// it the tools are absent rather than advertised and broken.
package vcs

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	DefaultTimeout = 30 * time.Second
	MaxOutputBytes = 60 * 1024
	DefaultLogN    = 20
	MaxLogN        = 200
)

// Refused outright: a repo here is either a mistake or an attempt to snapshot
// somewhere the agent has no business writing .jj into.
var refusedPrefixes = []string{
	"/System",
	"/Library",
	"/private/var/db",
	"/etc",
	"/bin",
	"/sbin",
	"/usr",
}

// jjPath is a seam so tests can point at a stub without a real jj install.
var jjPath = func() string {
	p, err := exec.LookPath("jj")
	if err != nil {
		return ""
	}
	return p
}

// runJJ executes jj as an argv list. Nothing reaches a shell, so a
// model-supplied revision or message cannot inject an operator.
var runJJ = func(ctx context.Context, dir string, args ...string) (string, string, error) {
	bin := jjPath()
	if bin == "" {
		return "", "", fmt.Errorf("jj is not installed or not on PATH")
	}
	ctx, cancel := context.WithTimeout(ctx, DefaultTimeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, bin, args...)
	cmd.Dir = dir
	// --no-pager keeps jj from blocking on a pager it thinks is a terminal.
	cmd.Env = append(os.Environ(), "JJ_CONFIG=", "NO_COLOR=1", "PAGER=cat")
	var out, errOut strings.Builder
	cmd.Stdout = &out
	cmd.Stderr = &errOut
	err := cmd.Run()
	if ctx.Err() == context.DeadlineExceeded {
		return "", "", fmt.Errorf("jj %s timed out after %s", args[0], DefaultTimeout)
	}
	return out.String(), errOut.String(), err
}

func Available() bool { return jjPath() != "" }

func errResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}

func okResult(payload map[string]any) (registry.Result, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return errResult(err), nil
	}
	return registry.Result{Content: body}, nil
}

func truncate(s string) (string, bool) {
	if len(s) <= MaxOutputBytes {
		return s, false
	}
	return s[:MaxOutputBytes], true
}

// resolveDir validates the workspace path before any jj command touches it.
func resolveDir(raw string) (string, error) {
	raw = strings.TrimSpace(raw)
	if raw == "" {
		return "", fmt.Errorf("path required")
	}
	if !filepath.IsAbs(raw) {
		return "", fmt.Errorf("path must be absolute: %s", raw)
	}
	clean := filepath.Clean(raw)
	for _, p := range refusedPrefixes {
		if clean == p || strings.HasPrefix(clean, p+"/") {
			return "", fmt.Errorf("refusing to operate on a system path: %s", clean)
		}
	}
	info, err := os.Stat(clean)
	if err != nil {
		return "", fmt.Errorf("cannot stat %s: %w", clean, err)
	}
	if !info.IsDir() {
		return "", fmt.Errorf("path is not a directory: %s", clean)
	}
	return clean, nil
}

type pathArgs struct {
	Path string `json:"path"`
}

const schemaPathOnly = `{
  "type":"object",
  "properties": {
    "path": {"type":"string","description":"Absolute path to the workspace directory."}
  },
  "required":["path"],
  "additionalProperties":false
}`

func init() {
	// Absent jj, these tools cannot do anything, so they are never offered
	// rather than advertised and failing on first use.
	if !Available() {
		return
	}
	registry.Register(&registry.Tool{
		Name: "vcs.init",
		Description: "Start tracking a directory with Jujutsu so the agent's edits become " +
			"checkpointed and reversible. Creates a self-contained local repository with no " +
			"remote and no hosting provider. If the directory is already a git repo it is " +
			"colocated, leaving git history and tooling intact.",
		Schema:          json.RawMessage(schemaPathOnly),
		Mutating:        true,
		Handler:         handleInit,
		TargetExtractor: extractPath,
	})
	registry.Register(&registry.Tool{
		Name: "vcs.status",
		Description: "Show what has changed in the working copy: files added, modified, or " +
			"deleted, plus the current change id. Use before and after editing to confirm " +
			"what actually changed on disk.",
		Schema:          json.RawMessage(schemaPathOnly),
		Mutating:        false,
		Handler:         handleStatus,
		TargetExtractor: extractPath,
	})
	registry.Register(&registry.Tool{
		Name: "vcs.checkpoint",
		Description: "Record a restore point and return its operation id. Call this BEFORE a " +
			"risky or multi-file edit; pass the returned id to vcs.undo to put the whole tree " +
			"back exactly as it was, including files that were deleted afterwards.",
		Schema: json.RawMessage(`{
  "type":"object",
  "properties": {
    "path":  {"type":"string","description":"Absolute path to the workspace directory."},
    "label": {"type":"string","description":"Optional note describing what is about to be attempted."}
  },
  "required":["path"],
  "additionalProperties":false
}`),
		Mutating:        false,
		Handler:         handleCheckpoint,
		TargetExtractor: extractPath,
	})
	registry.Register(&registry.Tool{
		Name: "vcs.diff",
		Description: "Show the actual line-level changes in the working copy, or of a specific " +
			"revision. Use to inspect what an edit did before deciding to keep it.",
		Schema: json.RawMessage(`{
  "type":"object",
  "properties": {
    "path":     {"type":"string","description":"Absolute path to the workspace directory."},
    "revision": {"type":"string","description":"Optional revision to diff. Defaults to the working copy."}
  },
  "required":["path"],
  "additionalProperties":false
}`),
		Mutating:        false,
		Handler:         handleDiff,
		TargetExtractor: extractPath,
	})
	registry.Register(&registry.Tool{
		Name: "vcs.history",
		Description: "List recent operations on the repository, newest first — the timeline of " +
			"restore points. Each entry's id can be passed to vcs.undo. This is repository " +
			"history, not commit history: it includes every snapshot, edit, and undo.",
		Schema: json.RawMessage(`{
  "type":"object",
  "properties": {
    "path":  {"type":"string","description":"Absolute path to the workspace directory."},
    "limit": {"type":"integer","minimum":1,"maximum":200,"description":"How many operations to return. Default 20."}
  },
  "required":["path"],
  "additionalProperties":false
}`),
		Mutating:        false,
		Handler:         handleHistory,
		TargetExtractor: extractPath,
	})
	registry.Register(&registry.Tool{
		Name: "vcs.undo",
		Description: "Rewind the workspace to a restore point from vcs.checkpoint or vcs.history, " +
			"restoring deleted files and discarding ones created since. With no operation id, " +
			"reverses only the most recent operation. This rewrites the working copy on disk.",
		Schema: json.RawMessage(`{
  "type":"object",
  "properties": {
    "path":      {"type":"string","description":"Absolute path to the workspace directory."},
    "operation": {"type":"string","description":"Operation id to restore to. Omit to undo just the last operation."}
  },
  "required":["path"],
  "additionalProperties":false
}`),
		Mutating:        true,
		Handler:         handleUndo,
		TargetExtractor: extractPath,
	})
}

func extractPath(args json.RawMessage) string {
	var probe pathArgs
	if err := json.Unmarshal(args, &probe); err != nil {
		return ""
	}
	return probe.Path
}

func handleInit(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args pathArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := resolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	if _, statErr := os.Stat(filepath.Join(dir, ".jj")); statErr == nil {
		return okResult(map[string]any{
			"path": dir, "already_initialized": true,
			"note": "workspace is already tracked; nothing changed",
		})
	}
	// Colocating keeps git history and any existing tooling working alongside jj.
	jjArgs := []string{"git", "init"}
	colocated := false
	if _, gitErr := os.Stat(filepath.Join(dir, ".git")); gitErr == nil {
		jjArgs = append(jjArgs, "--colocate")
		colocated = true
	}
	_, stderr, runErr := runJJ(ctx, dir, jjArgs...)
	if runErr != nil {
		return errResult(fmt.Errorf("jj git init failed: %s", firstLine(stderr, runErr))), nil
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
	dir, err := resolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	stdout, stderr, runErr := runJJ(ctx, dir, "status")
	if runErr != nil {
		return errResult(fmt.Errorf("jj status failed: %s", firstLine(stderr, runErr))), nil
	}
	text, clipped := truncate(stdout)
	return okResult(map[string]any{
		"path": dir, "status": text, "truncated": clipped,
		"clean": strings.Contains(stdout, "The working copy has no changes"),
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
	dir, err := resolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	// `jj status` is the cheapest command that forces a working-copy snapshot,
	// so the id returned below already includes edits made moments ago.
	if _, stderr, runErr := runJJ(ctx, dir, "status"); runErr != nil {
		return errResult(fmt.Errorf("jj status failed: %s", firstLine(stderr, runErr))), nil
	}
	stdout, stderr, runErr := runJJ(ctx, dir, "op", "log", "--no-graph", "-n", "1", "-T", "id.short()")
	if runErr != nil {
		return errResult(fmt.Errorf("jj op log failed: %s", firstLine(stderr, runErr))), nil
	}
	opID := strings.TrimSpace(stdout)
	if opID == "" {
		return errResult(fmt.Errorf("could not determine operation id")), nil
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
	dir, err := resolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	jjArgs := []string{"diff"}
	if rev := strings.TrimSpace(args.Revision); rev != "" {
		jjArgs = append(jjArgs, "-r", rev)
	}
	stdout, stderr, runErr := runJJ(ctx, dir, jjArgs...)
	if runErr != nil {
		return errResult(fmt.Errorf("jj diff failed: %s", firstLine(stderr, runErr))), nil
	}
	text, clipped := truncate(stdout)
	return okResult(map[string]any{
		"path": dir, "revision": args.Revision, "diff": text,
		"truncated": clipped, "empty": strings.TrimSpace(stdout) == "",
	})
}

type operation struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Time        string `json:"time"`
}

func handleHistory(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Path  string `json:"path"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := resolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	limit := args.Limit
	if limit <= 0 {
		limit = DefaultLogN
	}
	if limit > MaxLogN {
		limit = MaxLogN
	}
	stdout, stderr, runErr := runJJ(ctx, dir, "op", "log", "--no-graph",
		"-n", fmt.Sprint(limit),
		"-T", `id.short() ++ "\t" ++ description ++ "\t" ++ time.end() ++ "\n"`)
	if runErr != nil {
		return errResult(fmt.Errorf("jj op log failed: %s", firstLine(stderr, runErr))), nil
	}
	return okResult(map[string]any{
		"path": dir, "operations": parseOperations(stdout), "limit": limit,
	})
}

func parseOperations(out string) []operation {
	ops := []operation{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 3)
		op := operation{ID: strings.TrimSpace(parts[0])}
		if len(parts) > 1 {
			op.Description = strings.TrimSpace(parts[1])
		}
		if len(parts) > 2 {
			op.Time = strings.TrimSpace(parts[2])
		}
		ops = append(ops, op)
	}
	return ops
}

func handleUndo(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Path      string `json:"path"`
		Operation string `json:"operation"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	dir, err := resolveDir(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	op := strings.TrimSpace(args.Operation)
	jjArgs := []string{"undo"}
	mode := "last-operation"
	if op != "" {
		jjArgs = []string{"op", "restore", op}
		mode = "restore-to-operation"
	}
	stdout, stderr, runErr := runJJ(ctx, dir, jjArgs...)
	if runErr != nil {
		return errResult(fmt.Errorf("jj %s failed: %s", mode, firstLine(stderr, runErr))), nil
	}
	// jj reports the outcome on stderr, which is the part worth showing back.
	detail := strings.TrimSpace(stderr)
	if detail == "" {
		detail = strings.TrimSpace(stdout)
	}
	text, clipped := truncate(detail)
	return okResult(map[string]any{
		"path": dir, "mode": mode, "operation": op,
		"result": text, "truncated": clipped,
	})
}

func firstLine(stderr string, err error) string {
	s := strings.TrimSpace(stderr)
	if s == "" {
		return err.Error()
	}
	if i := strings.Index(s, "\n"); i > 0 {
		return s[:i]
	}
	return s
}
