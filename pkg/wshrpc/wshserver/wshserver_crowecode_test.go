// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package wshserver

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestCroweCodeBootstrapScopeRejectsEmptyBlockId(t *testing.T) {
	ws := &WshServer{}
	_, err := ws.CroweCodeBootstrapScopeCommand(context.Background(), wshrpc.CommandCroweCodeBootstrapScopeData{})
	if err == nil {
		t.Fatal("expected error for empty blockid")
	}
	if !strings.Contains(err.Error(), "blockid") {
		t.Fatalf("error should mention blockid: %v", err)
	}
}

func TestCroweCodeBootstrapScopeSandboxDefault(t *testing.T) {
	ws := &WshServer{}
	scope.DefaultStore().Revoke("test-block-1", "default")

	rtn, err := ws.CroweCodeBootstrapScopeCommand(context.Background(), wshrpc.CommandCroweCodeBootstrapScopeData{
		BlockId:   "test-block-1",
		PathGlobs: []string{"/Users/me/Projects/*"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !rtn.Granted {
		t.Fatal("expected granted=true")
	}
	if rtn.ScopeName != "sandbox" {
		t.Fatalf("expected scopename=sandbox, got %s", rtn.ScopeName)
	}
	if rtn.AgentSessionId != "default" {
		t.Fatalf("expected default session id, got %s", rtn.AgentSessionId)
	}
	if rtn.Tools[scope.ToolEditorWrite] != scope.ModeAllow {
		t.Fatalf("sandbox should allow write, got %v", rtn.Tools)
	}
}

func TestCroweCodeBootstrapScopeReadOnly(t *testing.T) {
	ws := &WshServer{}
	scope.DefaultStore().Revoke("test-block-2", "default")

	rtn, err := ws.CroweCodeBootstrapScopeCommand(context.Background(), wshrpc.CommandCroweCodeBootstrapScopeData{
		BlockId:   "test-block-2",
		ScopeName: "readonly",
		PathGlobs: []string{"/x/*"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rtn.Tools[scope.ToolEditorWrite] != scope.ModeDeny {
		t.Fatalf("readonly should deny write, got %v", rtn.Tools)
	}
	if rtn.Tools[scope.ToolEditorRead] != scope.ModeAllow {
		t.Fatalf("readonly should allow read, got %v", rtn.Tools)
	}
}

func TestCroweCodeBootstrapScopePermissive(t *testing.T) {
	ws := &WshServer{}
	scope.DefaultStore().Revoke("test-block-3", "default")

	rtn, err := ws.CroweCodeBootstrapScopeCommand(context.Background(), wshrpc.CommandCroweCodeBootstrapScopeData{
		BlockId:   "test-block-3",
		ScopeName: "permissive",
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if rtn.Tools[scope.ToolEditorWrite] != scope.ModeAllow {
		t.Fatalf("permissive should allow write, got %v", rtn.Tools)
	}
	if len(rtn.TargetPatterns) != 0 {
		t.Fatalf("permissive should have no target patterns, got %v", rtn.TargetPatterns)
	}
}
