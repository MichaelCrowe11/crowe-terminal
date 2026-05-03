// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
	"path"
	"time"
)

const (
	ModeDeny  = "deny"
	ModeAsk   = "ask"
	ModeAllow = "allow"

	DefaultMode = ModeAsk
)

// CapabilityGrant scopes an agent's right to call a specific tool against a
// specific block. Grants live alongside workspaces and survive reopen.
//
// The model layers below the global allowlist + denylist already in
// pkg/agent/tools/allowlist and pkg/agent/denylist: a grant cannot promote a
// tool that the global denylist forbids, but a grant CAN demote a globally
// allowed tool. Defense in depth runs from outer fence inward.
type CapabilityGrant struct {
	BlockID        string
	AgentSessionID string

	Tools map[string]string

	TargetPatterns map[string][]string

	ExpiresAt *time.Time
}

// CheckResult is the resolved decision for a single (block, agent, tool, target)
// tuple. Consumers branch on Mode; Reason is the human-readable justification
// surfaced in the point-of-action UI.
type CheckResult struct {
	Mode   string
	Reason string
}

// Store is the persistence boundary for grants. The default in-memory impl is
// in memstore.go; a workspace-backed store will land in a follow-up change.
type Store interface {
	Get(blockID, agentSessionID string) (*CapabilityGrant, bool)
	Put(grant *CapabilityGrant)
	Promote(blockID, agentSessionID, toolName string, mode string)
	Revoke(blockID, agentSessionID string)
}

// Check resolves the mode for one tool call against one block. The caller
// supplies the optional target string (a file path, URL, or block id) that the
// tool would operate on; pattern matching uses path.Match so callers can pass
// glob-style restrictions in TargetPatterns.
func Check(store Store, blockID, agentSessionID, toolName, target string, now time.Time) CheckResult {
	if store == nil {
		return CheckResult{Mode: DefaultMode, Reason: "no store configured"}
	}
	grant, ok := store.Get(blockID, agentSessionID)
	if !ok {
		return CheckResult{Mode: DefaultMode, Reason: "no grant for this block"}
	}
	if grant.ExpiresAt != nil && now.After(*grant.ExpiresAt) {
		return CheckResult{Mode: DefaultMode, Reason: "grant expired"}
	}
	mode, ok := grant.Tools[toolName]
	if !ok {
		return CheckResult{Mode: DefaultMode, Reason: "tool not in grant"}
	}
	if mode == ModeDeny {
		return CheckResult{Mode: ModeDeny, Reason: "explicitly denied for this block"}
	}
	if !targetMatches(grant, toolName, target) {
		return CheckResult{Mode: DefaultMode, Reason: "target outside granted patterns"}
	}
	return CheckResult{Mode: mode, Reason: "matched grant"}
}

func targetMatches(grant *CapabilityGrant, toolName, target string) bool {
	if grant.TargetPatterns == nil {
		return true
	}
	patterns, ok := grant.TargetPatterns[toolName]
	if !ok || len(patterns) == 0 {
		return true
	}
	if target == "" {
		return false
	}
	for _, p := range patterns {
		matched, err := path.Match(p, target)
		if err == nil && matched {
			return true
		}
	}
	return false
}
