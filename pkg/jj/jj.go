// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package jj is the single implementation of "how we talk to Jujutsu".
// Two consumers share it: the agent tools in pkg/agent/tools/vcs and the
// vcs wshrpc commands behind the repository dock panel. Keeping argv
// construction, error translation, and output parsing in one place means
// the two surfaces cannot drift apart.
package jj

import (
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
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

// LookPath is a seam so tests can point at a stub without a real jj install.
var LookPath = func() string {
	p, err := exec.LookPath("jj")
	if err != nil {
		return ""
	}
	return p
}

// Run executes jj as an argv list. Nothing reaches a shell, so a
// model-supplied revision or message cannot inject an operator.
var Run = func(ctx context.Context, dir string, args ...string) (string, string, error) {
	bin := LookPath()
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

func Available() bool { return LookPath() != "" }

// ResolveDir validates the workspace path before any jj command touches it.
func ResolveDir(raw string) (string, error) {
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

func Truncate(s string) (string, bool) {
	if len(s) <= MaxOutputBytes {
		return s, false
	}
	return s[:MaxOutputBytes], true
}

func FirstLine(stderr string, err error) string {
	s := strings.TrimSpace(stderr)
	if s == "" {
		return err.Error()
	}
	if i := strings.Index(s, "\n"); i > 0 {
		return s[:i]
	}
	return s
}

type Operation struct {
	ID          string `json:"id"`
	Description string `json:"description"`
	Time        string `json:"time"`
	TimeRel     string `json:"-"`
}

func parseOperations(out string) []Operation {
	ops := []Operation{}
	for _, line := range strings.Split(out, "\n") {
		if strings.TrimSpace(line) == "" {
			continue
		}
		parts := strings.SplitN(line, "\t", 4)
		op := Operation{ID: strings.TrimSpace(parts[0])}
		if len(parts) > 1 {
			op.Description = strings.TrimSpace(parts[1])
		}
		if len(parts) > 2 {
			op.Time = strings.TrimSpace(parts[2])
		}
		if len(parts) > 3 {
			op.TimeRel = strings.TrimSpace(parts[3])
		}
		ops = append(ops, op)
	}
	return ops
}

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
