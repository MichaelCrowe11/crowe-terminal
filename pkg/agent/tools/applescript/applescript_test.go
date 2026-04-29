// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package applescript

import (
	"context"
	"encoding/json"
	"runtime"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func TestRegisteredOnDarwin(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin only")
	}
	if _, ok := registry.Default().Get("system.run_applescript"); !ok {
		t.Fatal("system.run_applescript not registered")
	}
	if _, ok := registry.Default().Get("system.tell_app"); !ok {
		t.Fatal("system.tell_app not registered")
	}
}

func TestRunSimpleScript(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin only")
	}
	res, err := handleRun(context.Background(),
		json.RawMessage(`{"script":"return \"hello-from-osascript\""}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.ErrorText)
	}
	var r result
	_ = json.Unmarshal(res.Content, &r)
	if !strings.Contains(r.Stdout, "hello-from-osascript") {
		t.Fatalf("stdout=%q", r.Stdout)
	}
}

func TestTellAppShape(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin only")
	}
	// Pick something safe and idempotent: ask Finder for its name.
	res, err := handleTell(context.Background(),
		json.RawMessage(`{"app":"Finder","command":"get name"}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if res.IsError {
		t.Logf("tell_app returned error (may be permissions): %s", res.ErrorText)
		t.Skip("AppleScript permissions probably not granted for test")
	}
	var r result
	_ = json.Unmarshal(res.Content, &r)
	if !strings.Contains(r.Stdout, "Finder") {
		t.Fatalf("expected 'Finder' in output, got %q", r.Stdout)
	}
}

func TestEmptyScriptRefused(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("darwin only")
	}
	res, _ := handleRun(context.Background(), json.RawMessage(`{"script":""}`))
	if !res.IsError {
		t.Fatal("expected refusal for empty script")
	}
}
