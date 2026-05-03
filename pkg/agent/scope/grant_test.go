// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
	"testing"
	"time"
)

func TestCheckNoGrantReturnsDefaultMode(t *testing.T) {
	store := MakeMemoryStore()
	result := Check(store, "blk-1", "sess-a", "terminal.exec_safe", "", time.Now())
	if result.Mode != DefaultMode {
		t.Fatalf("got mode %q, want %q", result.Mode, DefaultMode)
	}
}

func TestCheckExplicitAllow(t *testing.T) {
	store := MakeMemoryStore()
	store.Promote("blk-1", "sess-a", "terminal.exec_safe", ModeAllow)
	result := Check(store, "blk-1", "sess-a", "terminal.exec_safe", "", time.Now())
	if result.Mode != ModeAllow {
		t.Fatalf("got mode %q, want %q", result.Mode, ModeAllow)
	}
}

func TestCheckExplicitDeny(t *testing.T) {
	store := MakeMemoryStore()
	store.Promote("blk-1", "sess-a", "editor.apply_edit", ModeDeny)
	result := Check(store, "blk-1", "sess-a", "editor.apply_edit", "", time.Now())
	if result.Mode != ModeDeny {
		t.Fatalf("got mode %q, want %q", result.Mode, ModeDeny)
	}
}

func TestCheckExpiredGrantFallsBackToDefault(t *testing.T) {
	store := MakeMemoryStore()
	past := time.Now().Add(-time.Hour)
	store.Put(&CapabilityGrant{
		BlockID:        "blk-1",
		AgentSessionID: "sess-a",
		Tools:          map[string]string{"terminal.exec_safe": ModeAllow},
		ExpiresAt:      &past,
	})
	result := Check(store, "blk-1", "sess-a", "terminal.exec_safe", "", time.Now())
	if result.Mode != DefaultMode {
		t.Fatalf("got mode %q, want %q", result.Mode, DefaultMode)
	}
}

func TestCheckTargetPatternMatch(t *testing.T) {
	store := MakeMemoryStore()
	store.Put(&CapabilityGrant{
		BlockID:        "blk-1",
		AgentSessionID: "sess-a",
		Tools:          map[string]string{"editor.apply_edit": ModeAllow},
		TargetPatterns: map[string][]string{
			"editor.apply_edit": {"src/*"},
		},
	})
	in := Check(store, "blk-1", "sess-a", "editor.apply_edit", "src/foo.go", time.Now())
	if in.Mode != ModeAllow {
		t.Fatalf("matched target should be allowed, got %q", in.Mode)
	}
	out := Check(store, "blk-1", "sess-a", "editor.apply_edit", "vendor/x.go", time.Now())
	if out.Mode != DefaultMode {
		t.Fatalf("unmatched target should fall back, got %q", out.Mode)
	}
}

func TestCheckEmptyTargetWithPatternFails(t *testing.T) {
	store := MakeMemoryStore()
	store.Put(&CapabilityGrant{
		BlockID:        "blk-1",
		AgentSessionID: "sess-a",
		Tools:          map[string]string{"editor.apply_edit": ModeAllow},
		TargetPatterns: map[string][]string{
			"editor.apply_edit": {"src/*"},
		},
	})
	result := Check(store, "blk-1", "sess-a", "editor.apply_edit", "", time.Now())
	if result.Mode != DefaultMode {
		t.Fatalf("empty target with pattern restriction should fall back, got %q", result.Mode)
	}
}

func TestRevoke(t *testing.T) {
	store := MakeMemoryStore()
	store.Promote("blk-1", "sess-a", "terminal.exec_safe", ModeAllow)
	store.Revoke("blk-1", "sess-a")
	result := Check(store, "blk-1", "sess-a", "terminal.exec_safe", "", time.Now())
	if result.Mode != DefaultMode {
		t.Fatalf("revoked grant should fall back to default, got %q", result.Mode)
	}
}

func TestPromoteIgnoresInvalidMode(t *testing.T) {
	store := MakeMemoryStore()
	store.Promote("blk-1", "sess-a", "terminal.exec_safe", "bogus")
	result := Check(store, "blk-1", "sess-a", "terminal.exec_safe", "", time.Now())
	if result.Mode != DefaultMode {
		t.Fatalf("invalid mode should not be stored, got %q", result.Mode)
	}
}

func TestNilStoreReturnsDefault(t *testing.T) {
	result := Check(nil, "blk-1", "sess-a", "terminal.exec_safe", "", time.Now())
	if result.Mode != DefaultMode {
		t.Fatalf("nil store should return default, got %q", result.Mode)
	}
}
