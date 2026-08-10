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
//
// The jj mechanics live in pkg/jj, shared with the repository dock's wshrpc
// commands.
package vcs

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/jj"
)

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
	if !jj.Available() {
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
