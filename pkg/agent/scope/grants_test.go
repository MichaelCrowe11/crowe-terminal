// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
	"testing"
	"time"
)

func TestGrantPermissiveAllowsEditor(t *testing.T) {
	s := MakeMemoryStore()
	GrantPermissive(s, "block-1", "sess-1")
	d := Check(s, "block-1", "sess-1", ToolEditorWrite, "/tmp/anything", time.Now())
	if d.Mode != ModeAllow {
		t.Fatalf("expected allow, got %+v", d)
	}
}

func TestGrantReadOnlyDeniesWrite(t *testing.T) {
	s := MakeMemoryStore()
	GrantReadOnly(s, "block-1", "sess-1", []string{"/Users/me/Projects/*"})
	if d := Check(s, "block-1", "sess-1", ToolEditorRead, "/Users/me/Projects/foo.go", time.Now()); d.Mode != ModeAllow {
		t.Fatalf("read should be allowed: %+v", d)
	}
	if d := Check(s, "block-1", "sess-1", ToolEditorWrite, "/Users/me/Projects/foo.go", time.Now()); d.Mode != ModeDeny {
		t.Fatalf("write should be denied even inside path: %+v", d)
	}
}

func TestGrantReadOnlyOutsideTargetIsAsk(t *testing.T) {
	s := MakeMemoryStore()
	GrantReadOnly(s, "block-1", "sess-1", []string{"/Users/me/Projects/*"})
	d := Check(s, "block-1", "sess-1", ToolEditorRead, "/etc/passwd", time.Now())
	if d.Mode != ModeAsk {
		t.Fatalf("read outside target glob should fall to ask: %+v", d)
	}
}

func TestGrantSandboxAllowsBoth(t *testing.T) {
	s := MakeMemoryStore()
	GrantSandbox(s, "block-1", "sess-1", []string{"/Users/me/Projects/*"})
	if d := Check(s, "block-1", "sess-1", ToolEditorWrite, "/Users/me/Projects/foo.go", time.Now()); d.Mode != ModeAllow {
		t.Fatalf("sandbox write should allow inside: %+v", d)
	}
	if d := Check(s, "block-1", "sess-1", ToolEditorWrite, "/elsewhere/foo.go", time.Now()); d.Mode != ModeAsk {
		t.Fatalf("sandbox write outside should ask: %+v", d)
	}
}

func TestGrantWithExpiry(t *testing.T) {
	s := MakeMemoryStore()
	g := &CapabilityGrant{
		BlockID:        "block-1",
		AgentSessionID: "sess-1",
		Tools:          map[string]string{ToolEditorRead: ModeAllow},
	}
	expired := GrantWithExpiry(g, -time.Minute)
	s.Put(expired)
	d := Check(s, "block-1", "sess-1", ToolEditorRead, "", time.Now())
	if d.Mode != ModeAsk {
		t.Fatalf("expired grant should fall back to ask: %+v", d)
	}
}

func TestSnapshotGrantNoGrant(t *testing.T) {
	s := MakeMemoryStore()
	snap := SnapshotGrant(s, "missing", "sess")
	if snap["granted"] != false {
		t.Fatalf("expected granted=false: %v", snap)
	}
}

func TestSnapshotGrantWithGrant(t *testing.T) {
	s := MakeMemoryStore()
	GrantSandbox(s, "block-1", "sess-1", []string{"/x/*"})
	snap := SnapshotGrant(s, "block-1", "sess-1")
	if snap["granted"] != true {
		t.Fatalf("expected granted=true: %v", snap)
	}
	if snap["blockid"] != "block-1" {
		t.Fatalf("expected blockid surfaced: %v", snap)
	}
}
