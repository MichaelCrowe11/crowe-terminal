// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package editor exposes file-based code editing tools to the agent.
// File-based (not buffer-based) so the agent operates on the same disk
// state the Crowe Code blocks load from. Open blocks see disk changes
// via their reload action (Phase 2a). Per-block scoping in Phase 4 will
// gate which paths a given block's agent can touch.
package editor

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	MaxReadBytes  = 1 << 20
	MaxWriteBytes = 4 << 20
	RecentCap     = 50
)

var sensitivePathPrefixes = []string{
	"/System",
	"/private/var/db",
	"/Library/Keychains",
	"/etc/ssh",
	"/etc/sudoers",
}

var sensitivePathSuffixes = []string{
	"/.aws/credentials",
	"/.aws/config",
	"/.netrc",
	"/.npmrc",
	"/.pypirc",
}

var sensitivePathSubstrings = []string{
	"/.ssh/id_",
	"/Keychains/",
	"/.gnupg/",
}

var sensitivePathExts = []string{
	".pem",
	".key",
	".pfx",
	".p12",
}

func init() {
	registry.Register(&registry.Tool{
		Name: "editor.read_file",
		Description: "Read a UTF-8 text file from disk and return its contents. " +
			"Use before any edit so you have ground truth, never assume the file's " +
			"current state. Rejects binary files, files larger than 1 MB, and paths " +
			"under sensitive system locations.",
		Schema:   json.RawMessage(schemaReadFile),
		Mutating: false,
		Handler:  handleReadFile,
	})
	registry.Register(&registry.Tool{
		Name: "editor.write_file",
		Description: "Overwrite a file (or create one) with the given UTF-8 contents. " +
			"Creates parent directories. Use for new files; for existing files prefer " +
			"editor.apply_edit so you cannot silently lose unrelated changes. Capped " +
			"at 4 MB.",
		Schema:   json.RawMessage(schemaWriteFile),
		Mutating: true,
		Handler:  handleWriteFile,
	})
	registry.Register(&registry.Tool{
		Name: "editor.apply_edit",
		Description: "Replace exactly one occurrence of old_text with new_text inside a " +
			"file. Fails if old_text is not present, or appears more than once. " +
			"Safer than write_file because it requires the file to be in a known " +
			"state. Use this for surgical changes inside existing files.",
		Schema:   json.RawMessage(schemaApplyEdit),
		Mutating: true,
		Handler:  handleApplyEdit,
	})
	registry.Register(&registry.Tool{
		Name: "editor.list_recent_files",
		Description: "Return the files this agent has read or written via the editor.* " +
			"tools in this process, most recent first. Useful for orienting yourself " +
			"in a long session.",
		Schema:   json.RawMessage(schemaListRecent),
		Mutating: false,
		Handler:  handleListRecent,
	})
}

const schemaReadFile = `{
  "type": "object",
  "properties": {
    "path": {"type":"string","description":"Absolute file path."}
  },
  "required":["path"],
  "additionalProperties":false
}`

const schemaWriteFile = `{
  "type": "object",
  "properties": {
    "path":     {"type":"string","description":"Absolute file path. Parent dirs are created if missing."},
    "contents": {"type":"string","description":"Full UTF-8 contents that will overwrite the file."}
  },
  "required":["path","contents"],
  "additionalProperties":false
}`

const schemaApplyEdit = `{
  "type": "object",
  "properties": {
    "path":     {"type":"string","description":"Absolute file path."},
    "old_text": {"type":"string","description":"Exact substring to find. Must appear exactly once in the file."},
    "new_text": {"type":"string","description":"Replacement text."}
  },
  "required":["path","old_text","new_text"],
  "additionalProperties":false
}`

const schemaListRecent = `{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}`

type readArgs struct {
	Path string `json:"path"`
}

type writeArgs struct {
	Path     string `json:"path"`
	Contents string `json:"contents"`
}

type editArgs struct {
	Path    string `json:"path"`
	OldText string `json:"old_text"`
	NewText string `json:"new_text"`
}

func handleReadFile(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args readArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	abs, err := normalizePath(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	info, err := os.Stat(abs)
	if err != nil {
		return errResult(err), nil
	}
	if info.IsDir() {
		return errResult(fmt.Errorf("path is a directory: %s", abs)), nil
	}
	if info.Size() > MaxReadBytes {
		return errResult(fmt.Errorf("file too large for read: %d bytes (cap %d)", info.Size(), MaxReadBytes)), nil
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return errResult(err), nil
	}
	if isLikelyBinary(data) {
		return errResult(fmt.Errorf("file appears to be binary: %s", abs)), nil
	}
	noteRecent(abs, "read")
	body, _ := json.Marshal(map[string]any{
		"path":     abs,
		"size":     info.Size(),
		"contents": string(data),
	})
	return registry.Result{Content: body}, nil
}

func handleWriteFile(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args writeArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	abs, err := normalizePath(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	if int64(len(args.Contents)) > MaxWriteBytes {
		return errResult(fmt.Errorf("contents too large: %d bytes (cap %d)", len(args.Contents), MaxWriteBytes)), nil
	}
	dir := filepath.Dir(abs)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return errResult(err), nil
	}
	prevSize := int64(-1)
	if info, err := os.Stat(abs); err == nil {
		prevSize = info.Size()
	}
	if err := os.WriteFile(abs, []byte(args.Contents), 0o644); err != nil {
		return errResult(err), nil
	}
	noteRecent(abs, "write")
	body, _ := json.Marshal(map[string]any{
		"path":          abs,
		"bytes_written": len(args.Contents),
		"prev_size":     prevSize,
		"created":       prevSize < 0,
	})
	return registry.Result{Content: body}, nil
}

func handleApplyEdit(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args editArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	abs, err := normalizePath(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	if args.OldText == "" {
		return errResult(fmt.Errorf("old_text must be non-empty")), nil
	}
	if args.OldText == args.NewText {
		body, _ := json.Marshal(map[string]any{
			"path":    abs,
			"changed": false,
			"reason":  "old_text equals new_text",
		})
		return registry.Result{Content: body}, nil
	}
	info, err := os.Stat(abs)
	if err != nil {
		return errResult(err), nil
	}
	if info.IsDir() {
		return errResult(fmt.Errorf("path is a directory: %s", abs)), nil
	}
	if info.Size() > MaxWriteBytes {
		return errResult(fmt.Errorf("file too large for edit: %d bytes (cap %d)", info.Size(), MaxWriteBytes)), nil
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return errResult(err), nil
	}
	if isLikelyBinary(data) {
		return errResult(fmt.Errorf("file appears to be binary: %s", abs)), nil
	}
	original := string(data)
	count := strings.Count(original, args.OldText)
	if count == 0 {
		return errResult(fmt.Errorf("old_text not found in %s", abs)), nil
	}
	if count > 1 {
		return errResult(fmt.Errorf("old_text appears %d times in %s; provide more surrounding context to make it unique", count, abs)), nil
	}
	updated := strings.Replace(original, args.OldText, args.NewText, 1)
	if int64(len(updated)) > MaxWriteBytes {
		return errResult(fmt.Errorf("result too large after edit: %d bytes (cap %d)", len(updated), MaxWriteBytes)), nil
	}
	if err := os.WriteFile(abs, []byte(updated), info.Mode().Perm()); err != nil {
		return errResult(err), nil
	}
	noteRecent(abs, "edit")
	body, _ := json.Marshal(map[string]any{
		"path":         abs,
		"changed":      true,
		"prev_size":    info.Size(),
		"new_size":     len(updated),
		"old_text_len": len(args.OldText),
		"new_text_len": len(args.NewText),
	})
	return registry.Result{Content: body}, nil
}

func handleListRecent(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	entries := snapshotRecent()
	body, _ := json.Marshal(map[string]any{
		"recent": entries,
		"count":  len(entries),
	})
	return registry.Result{Content: body}, nil
}

func normalizePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", fmt.Errorf("path required")
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("path must be absolute: %s", p)
	}
	cleaned := filepath.Clean(p)
	abs, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		// File may not exist yet (write_file). Resolve the parent
		// directory if possible so a write of /var/foo/new.txt and a
		// later read of the same path collapse to the same canonical
		// /private/var/foo/new.txt on macOS.
		parent := filepath.Dir(cleaned)
		if resolvedParent, perr := filepath.EvalSymlinks(parent); perr == nil {
			abs = filepath.Join(resolvedParent, filepath.Base(cleaned))
		} else {
			abs = cleaned
		}
	}
	if blocked, why := isSensitive(cleaned); blocked {
		return "", fmt.Errorf("path is in a protected location (%s): %s", why, cleaned)
	}
	if abs != cleaned {
		if blocked, why := isSensitive(abs); blocked {
			return "", fmt.Errorf("path resolves to a protected location (%s): %s -> %s", why, cleaned, abs)
		}
	}
	return abs, nil
}

func isSensitive(abs string) (bool, string) {
	for _, prefix := range sensitivePathPrefixes {
		if strings.HasPrefix(abs, prefix+"/") || abs == prefix {
			return true, "system path"
		}
	}
	for _, suffix := range sensitivePathSuffixes {
		if strings.HasSuffix(abs, suffix) {
			return true, "credential file"
		}
	}
	for _, sub := range sensitivePathSubstrings {
		if strings.Contains(abs, sub) {
			return true, "secret store"
		}
	}
	ext := strings.ToLower(filepath.Ext(abs))
	for _, e := range sensitivePathExts {
		if ext == e {
			return true, "key material"
		}
	}
	base := filepath.Base(abs)
	if base == ".env" || strings.HasPrefix(base, ".env.") {
		return true, "env file"
	}
	return false, ""
}

func isLikelyBinary(data []byte) bool {
	limit := len(data)
	if limit > 8000 {
		limit = 8000
	}
	for i := 0; i < limit; i++ {
		if data[i] == 0 {
			return true
		}
	}
	return false
}

func errResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}

type recentEntry struct {
	Path string `json:"path"`
	Op   string `json:"op"`
	At   string `json:"at"`
}

var (
	recentLock sync.Mutex
	recentList []recentEntry
)

func noteRecent(path, op string) {
	recentLock.Lock()
	defer recentLock.Unlock()
	for i, e := range recentList {
		if e.Path == path {
			recentList = append(recentList[:i], recentList[i+1:]...)
			break
		}
	}
	recentList = append([]recentEntry{{Path: path, Op: op, At: time.Now().UTC().Format(time.RFC3339)}}, recentList...)
	if len(recentList) > RecentCap {
		recentList = recentList[:RecentCap]
	}
}

func snapshotRecent() []recentEntry {
	recentLock.Lock()
	defer recentLock.Unlock()
	out := make([]recentEntry, len(recentList))
	copy(out, recentList)
	sort.SliceStable(out, func(i, j int) bool { return out[i].At > out[j].At })
	return out
}
