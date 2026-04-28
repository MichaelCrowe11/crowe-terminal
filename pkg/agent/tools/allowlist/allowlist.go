// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package allowlist persists user-approved patterns and exposes them
// as agent tools. The allowlist NEVER overrides the denylist —
// patterns matching denylist.IsMutating cannot be allowlisted, even
// if a user adds them via the UI.
package allowlist

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/denylist"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	KindCommand  = "command"
	KindURL      = "url"
	KindSelector = "selector"

	configDirName = "crowe-terminal"
	fileName      = "allowlist.json"
)

type Pattern struct {
	Kind    string `json:"kind"`
	Pattern string `json:"pattern"`
	AddedAt int64  `json:"addedat"`
	Notes   string `json:"notes,omitempty"`
}

type fileShape struct {
	Patterns []Pattern `json:"patterns"`
}

var (
	storeLock sync.RWMutex
	store     []Pattern
	loadOnce  sync.Once
)

func init() {
	registry.Register(&registry.Tool{
		Name:        "allowlist.check",
		Description: "Check whether a candidate command/URL/selector is already allowlisted. Read-only.",
		Schema:      json.RawMessage(SchemaCheck),
		Mutating:    false,
		Handler:     handleCheck,
	})
	registry.Register(&registry.Tool{
		Name: "allowlist.list",
		Description: "List all currently allowlisted patterns. Use to show the user what they have approved.",
		Schema:   json.RawMessage(`{"type":"object","additionalProperties":false}`),
		Mutating: false,
		Handler:  handleList,
	})
	registry.Register(&registry.Tool{
		Name: "allowlist.add",
		Description: "Add a pattern to the user's allowlist. Refuses any pattern matching the mutating-command denylist.",
		Schema:   json.RawMessage(SchemaAdd),
		Mutating: true,
		Handler:  handleAdd,
	})
}

const SchemaCheck = `{
  "type": "object",
  "properties": {
    "kind":    {"type": "string", "enum": ["command","url","selector"]},
    "candidate": {"type": "string", "minLength": 1}
  },
  "required": ["kind","candidate"],
  "additionalProperties": false
}`

const SchemaAdd = `{
  "type": "object",
  "properties": {
    "kind":    {"type": "string", "enum": ["command","url","selector"]},
    "pattern": {"type": "string", "minLength": 1},
    "notes":   {"type": "string"}
  },
  "required": ["kind","pattern"],
  "additionalProperties": false
}`

func ConfigPath() string {
	base, err := os.UserConfigDir()
	if err != nil {
		base = filepath.Join(os.Getenv("HOME"), ".config")
	}
	return filepath.Join(base, configDirName, fileName)
}

func ensureLoaded() {
	loadOnce.Do(func() {
		store = load()
	})
}

func load() []Pattern {
	path := ConfigPath()
	b, err := os.ReadFile(path)
	if err != nil {
		return defaultPatterns()
	}
	var f fileShape
	if err := json.Unmarshal(b, &f); err != nil {
		return defaultPatterns()
	}
	if len(f.Patterns) == 0 {
		return defaultPatterns()
	}
	return f.Patterns
}

func save() error {
	path := ConfigPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	storeLock.RLock()
	body, err := json.MarshalIndent(fileShape{Patterns: store}, "", "  ")
	storeLock.RUnlock()
	if err != nil {
		return err
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, body, 0o600); err != nil {
		return err
	}
	return os.Rename(tmp, path)
}

func defaultPatterns() []Pattern {
	now := time.Now().UnixMilli()
	commands := []string{
		"ls", "ls *", "pwd", "whoami", "date", "uptime", "hostname",
		"git status", "git log", "git log *", "git diff", "git diff *",
		"git branch", "git remote -v",
		"cat *.md", "cat *.json", "cat *.txt", "cat *.yaml", "cat *.yml",
		"cat *.toml", "cat *.go", "cat *.ts", "cat *.tsx", "cat *.py",
		"head *", "tail *", "wc *", "file *",
		"grep *", "rg *", "find * -name *", "fd *",
		"which *", "type *", "command -v *",
		"node --version", "npm --version", "python --version", "python3 --version",
		"go version", "rustc --version", "deno --version", "bun --version",
		"df -h", "df", "free -h", "free", "top -l 1", "ps", "ps aux", "ps -ef",
		"kubectl get *", "kubectl describe *", "kubectl logs *",
		"docker ps", "docker ps *", "docker images", "docker logs *",
		"curl --help", "wget --help",
	}
	out := make([]Pattern, 0, len(commands))
	for _, c := range commands {
		out = append(out, Pattern{Kind: KindCommand, Pattern: c, AddedAt: now, Notes: "default"})
	}
	return out
}

func handleCheck(_ context.Context, raw json.RawMessage) (registry.Result, error) {
	var args struct {
		Kind      string `json:"kind"`
		Candidate string `json:"candidate"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	allowed := Check(args.Kind, args.Candidate)
	body, _ := json.Marshal(map[string]any{"allowed": allowed, "kind": args.Kind, "candidate": args.Candidate})
	return registry.Result{Content: body}, nil
}

func handleList(_ context.Context, _ json.RawMessage) (registry.Result, error) {
	ensureLoaded()
	storeLock.RLock()
	defer storeLock.RUnlock()
	body, _ := json.Marshal(map[string]any{"patterns": store})
	return registry.Result{Content: body}, nil
}

func handleAdd(_ context.Context, raw json.RawMessage) (registry.Result, error) {
	var p Pattern
	if err := json.Unmarshal(raw, &p); err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	if err := Add(p); err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	body, _ := json.Marshal(map[string]any{"added": true, "pattern": p})
	return registry.Result{Content: body}, nil
}

func Check(kind, candidate string) bool {
	ensureLoaded()
	if kind == KindCommand && denylist.IsMutating(candidate) {
		return false
	}
	storeLock.RLock()
	defer storeLock.RUnlock()
	for _, p := range store {
		if p.Kind != kind {
			continue
		}
		if matchPattern(p.Pattern, candidate) {
			return true
		}
	}
	return false
}

func Add(p Pattern) error {
	ensureLoaded()
	if p.Kind == "" || p.Pattern == "" {
		return fmt.Errorf("kind and pattern required")
	}
	if p.Kind == KindCommand && denylist.IsMutating(p.Pattern) {
		return fmt.Errorf("pattern matches mutating denylist; cannot be allowlisted: %q", p.Pattern)
	}
	if p.AddedAt == 0 {
		p.AddedAt = time.Now().UnixMilli()
	}
	storeLock.Lock()
	for i := range store {
		if store[i].Kind == p.Kind && store[i].Pattern == p.Pattern {
			storeLock.Unlock()
			return nil
		}
	}
	store = append(store, p)
	storeLock.Unlock()
	return save()
}

func matchPattern(pat, candidate string) bool {
	if pat == candidate {
		return true
	}
	if !strings.ContainsAny(pat, "*?[") {
		return strings.HasPrefix(candidate, pat+" ")
	}
	rx := globToRegex(pat)
	matched, _ := regexp.MatchString("^"+rx+"$", candidate)
	return matched
}

func globToRegex(g string) string {
	var b strings.Builder
	for _, r := range g {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		case '.', '+', '(', ')', '|', '^', '$', '\\':
			b.WriteByte('\\')
			b.WriteRune(r)
		default:
			b.WriteRune(r)
		}
	}
	return b.String()
}
