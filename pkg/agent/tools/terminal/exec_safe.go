// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package terminal exposes terminal-driving tools to the agent. The
// safe-vs-mutating split:
//
//   - exec_safe runs a fresh subprocess for read-only commands; any
//     command matching the denylist is refused without exception.
//   - propose_command (in propose.go) handles mutations by typing into
//     the user's visible terminal block without pressing Enter.
package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/denylist"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/tools/allowlist"
	"github.com/wavetermdev/waveterm/pkg/util/pathutil"
)

const (
	defaultTimeoutSec = 30
	maxTimeoutSec     = 120
	maxOutputBytes    = 256 * 1024
)

const SchemaExecSafe = `{
  "type": "object",
  "properties": {
    "command": {"type": "string", "minLength": 1, "description": "Shell command to run, e.g. 'git status'."},
    "cwd":     {"type": "string", "description": "Working directory. Defaults to $HOME."},
    "timeout_sec": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30}
  },
  "required": ["command"],
  "additionalProperties": false
}`

type execArgs struct {
	Command    string `json:"command"`
	Cwd        string `json:"cwd"`
	TimeoutSec int    `json:"timeout_sec"`
}

type execResult struct {
	Command    string `json:"command"`
	Cwd        string `json:"cwd"`
	ExitCode   int    `json:"exit_code"`
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr"`
	DurationMs int64  `json:"duration_ms"`
	Truncated  bool   `json:"truncated,omitempty"`
}

func init() {
	registry.Register(&registry.Tool{
		Name: "terminal.exec_safe",
		Description: "Run a read-only shell command in a fresh subprocess. " +
			"Refuses any command matching the mutating denylist (rm, sudo, git push, " +
			"package installs, redirects outside /tmp, subshells, pipes to sh/bash, etc.). " +
			"Use terminal.propose_command for anything that mutates state.",
		Schema:   json.RawMessage(SchemaExecSafe),
		Mutating: false,
		Handler:  handleExecSafe,
	})
}

func handleExecSafe(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args execArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return registry.Result{IsError: true, ErrorText: "invalid arguments: " + err.Error()}, nil
	}
	cmd := strings.TrimSpace(args.Command)
	if cmd == "" {
		return registry.Result{IsError: true, ErrorText: "empty command"}, nil
	}
	if denylist.IsMutating(cmd) {
		return registry.Result{
			IsError:   true,
			ErrorText: "command refused: matches mutating denylist; use terminal.propose_command instead",
		}, nil
	}
	timeout := args.TimeoutSec
	if timeout <= 0 {
		timeout = defaultTimeoutSec
	}
	if timeout > maxTimeoutSec {
		timeout = maxTimeoutSec
	}
	cwd := args.Cwd
	if cwd == "" {
		if h, err := os.UserHomeDir(); err == nil {
			cwd = h
		}
	}
	parts, perr := splitCommand(cmd)
	if perr != nil || len(parts) == 0 {
		return registry.Result{IsError: true, ErrorText: "could not parse command"}, nil
	}
	if !allowlist.Check(allowlist.KindCommand, cmd) {
		// Allowlist miss is not an outright refusal — exec_safe still runs
		// because we already verified non-mutating. Surface it so the
		// agent can offer to remember the pattern.
	}

	exe := pathutil.LookPath(parts[0])
	if exe == "" {
		return registry.Result{IsError: true, ErrorText: "command not found: " + parts[0]}, nil
	}

	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeout)*time.Second)
	defer cancel()

	c := exec.CommandContext(runCtx, exe, parts[1:]...)
	c.Dir = cwd
	// The child needs the augmented PATH too: resolving `git` is pointless if
	// git then cannot find the helpers it shells out to.
	c.Env = pathutil.EnvWithPATH(append(os.Environ(), "CROWE_AGENT_EXEC=1"))

	start := time.Now()
	stdout, stderr, exitCode, runErr := runCapture(c)
	dur := time.Since(start).Milliseconds()

	res := execResult{
		Command:    cmd,
		Cwd:        cwd,
		ExitCode:   exitCode,
		DurationMs: dur,
	}
	res.Stdout = truncate(stdout, &res)
	res.Stderr = truncate(stderr, &res)
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		res.Stderr += fmt.Sprintf("\n[crowe-agent] timed out after %ds", timeout)
		res.ExitCode = 124
	}
	body, err := json.Marshal(res)
	if err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	out := registry.Result{Content: body}
	if runErr != nil && exitCode == 0 {
		out.IsError = true
		out.ErrorText = runErr.Error()
	}
	return out, nil
}

func runCapture(c *exec.Cmd) (string, string, int, error) {
	var stdout, stderr strings.Builder
	c.Stdout = &stdout
	c.Stderr = &stderr
	err := c.Run()
	exitCode := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}
	return stdout.String(), stderr.String(), exitCode, err
}

func truncate(s string, res *execResult) string {
	if len(s) <= maxOutputBytes {
		return s
	}
	res.Truncated = true
	return s[:maxOutputBytes] + "\n[truncated]"
}

// splitCommand is a minimal POSIX-ish tokenizer. Handles single quotes,
// double quotes, and backslash escapes. No variable/glob expansion (we
// don't run through a shell, so expansion would be a footgun anyway).
func splitCommand(s string) ([]string, error) {
	var (
		parts []string
		cur   strings.Builder
		quote byte
		esc   bool
		empty = true
	)
	flush := func() {
		if !empty {
			parts = append(parts, cur.String())
			cur.Reset()
			empty = true
		}
	}
	for i := 0; i < len(s); i++ {
		ch := s[i]
		if esc {
			cur.WriteByte(ch)
			empty = false
			esc = false
			continue
		}
		if quote == 0 && ch == '\\' {
			esc = true
			continue
		}
		if quote == 0 && (ch == '"' || ch == '\'') {
			quote = ch
			empty = false
			continue
		}
		if quote != 0 && ch == quote {
			quote = 0
			continue
		}
		if quote == 0 && (ch == ' ' || ch == '\t') {
			flush()
			continue
		}
		cur.WriteByte(ch)
		empty = false
	}
	if quote != 0 {
		return nil, fmt.Errorf("unbalanced %c quote", quote)
	}
	flush()
	return parts, nil
}
