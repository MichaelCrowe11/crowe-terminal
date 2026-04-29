// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package applescript exposes macOS UI automation as agent tools.
// AppleScript is a wide attack surface — it can open apps, send
// keystrokes, control Music/Finder/Mail/Safari/etc., manipulate
// windows, drive Notification Center. So:
//
//   - The tools are mutating by definition (they affect UI state).
//   - They register only on darwin.
//   - The osascript subprocess inherits the user's environment but
//     runs with a hard timeout.
//   - We expose two flavors: run_applescript (literal script) and
//     tell_app (a structured "tell application X to ..." sugar).
package applescript

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os/exec"
	"runtime"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	defaultTimeoutSec = 30
	maxTimeoutSec     = 120
	maxOutputBytes    = 64 * 1024
)

const SchemaRunApplescript = `{
  "type": "object",
  "properties": {
    "script":      {"type": "string", "minLength": 1, "description": "AppleScript source. Multiline OK."},
    "timeout_sec": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30}
  },
  "required": ["script"],
  "additionalProperties": false
}`

const SchemaTellApp = `{
  "type": "object",
  "properties": {
    "app":     {"type": "string", "minLength": 1, "description": "Application name, e.g. 'Music', 'Finder', 'Safari'."},
    "command": {"type": "string", "minLength": 1, "description": "AppleScript command to send to the app, e.g. 'play', 'activate', 'pause'."},
    "timeout_sec": {"type": "integer", "minimum": 1, "maximum": 120, "default": 30}
  },
  "required": ["app","command"],
  "additionalProperties": false
}`

type runArgs struct {
	Script     string `json:"script"`
	TimeoutSec int    `json:"timeout_sec"`
}

type tellArgs struct {
	App        string `json:"app"`
	Command    string `json:"command"`
	TimeoutSec int    `json:"timeout_sec"`
}

type result struct {
	Stdout     string `json:"stdout"`
	Stderr     string `json:"stderr,omitempty"`
	ExitCode   int    `json:"exit_code"`
	DurationMs int64  `json:"duration_ms"`
}

func init() {
	if runtime.GOOS != "darwin" {
		return
	}
	registry.Register(&registry.Tool{
		Name: "system.run_applescript",
		Description: "Run an AppleScript via osascript. macOS only. " +
			"Mutating: AppleScript can affect any application's state, send keystrokes, " +
			"open/close windows, control Music/Finder/Mail/Safari, etc.",
		Schema:   json.RawMessage(SchemaRunApplescript),
		Mutating: true,
		Handler:  handleRun,
	})
	registry.Register(&registry.Tool{
		Name: "system.tell_app",
		Description: "Send a single AppleScript command to a named macOS application " +
			"('tell application \"X\" to Y'). Sugar over run_applescript for the common case.",
		Schema:   json.RawMessage(SchemaTellApp),
		Mutating: true,
		Handler:  handleTell,
	})
}

func handleRun(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args runArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return registry.Result{IsError: true, ErrorText: "invalid arguments: " + err.Error()}, nil
	}
	if strings.TrimSpace(args.Script) == "" {
		return registry.Result{IsError: true, ErrorText: "script required"}, nil
	}
	return runOsa(ctx, []string{"-e", args.Script}, args.TimeoutSec)
}

func handleTell(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args tellArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return registry.Result{IsError: true, ErrorText: "invalid arguments: " + err.Error()}, nil
	}
	if strings.TrimSpace(args.App) == "" || strings.TrimSpace(args.Command) == "" {
		return registry.Result{IsError: true, ErrorText: "app and command required"}, nil
	}
	script := fmt.Sprintf(`tell application %q to %s`, args.App, args.Command)
	return runOsa(ctx, []string{"-e", script}, args.TimeoutSec)
}

func runOsa(ctx context.Context, osaArgs []string, timeoutSec int) (registry.Result, error) {
	if timeoutSec <= 0 {
		timeoutSec = defaultTimeoutSec
	}
	if timeoutSec > maxTimeoutSec {
		timeoutSec = maxTimeoutSec
	}
	runCtx, cancel := context.WithTimeout(ctx, time.Duration(timeoutSec)*time.Second)
	defer cancel()

	c := exec.CommandContext(runCtx, "osascript", osaArgs...)
	var stdout, stderr strings.Builder
	c.Stdout = &stdout
	c.Stderr = &stderr
	start := time.Now()
	err := c.Run()
	dur := time.Since(start).Milliseconds()

	exitCode := 0
	if err != nil {
		var ee *exec.ExitError
		if errors.As(err, &ee) {
			exitCode = ee.ExitCode()
		} else {
			exitCode = -1
		}
	}
	r := result{
		Stdout:     truncate(stdout.String()),
		Stderr:     truncate(stderr.String()),
		ExitCode:   exitCode,
		DurationMs: dur,
	}
	if errors.Is(runCtx.Err(), context.DeadlineExceeded) {
		r.Stderr += fmt.Sprintf("\n[crowe-agent] osascript timed out after %ds", timeoutSec)
		r.ExitCode = 124
	}
	body, _ := json.Marshal(r)
	out := registry.Result{Content: body}
	if exitCode != 0 {
		out.IsError = true
		out.ErrorText = strings.TrimSpace(r.Stderr)
		if out.ErrorText == "" {
			out.ErrorText = fmt.Sprintf("osascript exited %d", exitCode)
		}
	}
	return out, nil
}

func truncate(s string) string {
	if len(s) <= maxOutputBytes {
		return s
	}
	return s[:maxOutputBytes] + "\n[truncated]"
}
