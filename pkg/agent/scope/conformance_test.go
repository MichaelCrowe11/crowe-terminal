// pkg/agent/scope/conformance_test.go
// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// These types mirror the shared conformance/vectors.json schema authored by the
// TS kernel. Only the fields that affect the pure decision are read; the
// grant's subjectId/sessionId/workspaceId are intentionally ignored.
type vectorGrant struct {
	Tools     map[string]string   `json:"tools"`
	Targets   map[string][]string `json:"targets"`
	ExpiresAt *int64              `json:"expiresAt"`
}

type vectorCase struct {
	Name   string       `json:"name"`
	Grant  *vectorGrant `json:"grant"`
	Tool   string       `json:"tool"`
	Target string       `json:"target"`
	Expect string       `json:"expect"`
}

type vectorFile struct {
	Now   int64        `json:"now"`
	Cases []vectorCase `json:"cases"`
}

// TestConformanceVectors is the parity gate: the Go resolver must reproduce the
// TS kernel's decision for every shared vector. If this fails after a kernel
// change, run scripts/sync-conformance-vectors.sh and reconcile the matcher.
func TestConformanceVectors(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("testdata", "vectors.json"))
	if err != nil {
		t.Fatalf("read vectors: %v", err)
	}
	var vf vectorFile
	if err := json.Unmarshal(data, &vf); err != nil {
		t.Fatalf("parse vectors: %v", err)
	}
	if len(vf.Cases) == 0 {
		t.Fatal("no conformance cases loaded")
	}
	now := time.UnixMilli(vf.Now)
	for _, c := range vf.Cases {
		c := c
		t.Run(c.Name, func(t *testing.T) {
			var grant *CapabilityGrant
			if c.Grant != nil {
				grant = &CapabilityGrant{
					Tools:          c.Grant.Tools,
					TargetPatterns: c.Grant.Targets,
				}
				if c.Grant.ExpiresAt != nil {
					exp := time.UnixMilli(*c.Grant.ExpiresAt)
					grant.ExpiresAt = &exp
				}
			}
			if got := CheckGrant(grant, c.Tool, c.Target, now).Mode; got != c.Expect {
				t.Fatalf("got %q, want %q", got, c.Expect)
			}
		})
	}
}
