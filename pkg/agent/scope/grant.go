// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
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

// Check resolves the mode for one tool call against one block. It looks up the
// grant in the store (nil store or missing grant resolves like a nil grant)
// and delegates to CheckGrant, the pure resolver mirrored from the TS kernel.
func Check(store Store, blockID, agentSessionID, toolName, target string, now time.Time) CheckResult {
	var grant *CapabilityGrant
	if store != nil {
		if g, ok := store.Get(blockID, agentSessionID); ok {
			grant = g
		}
	}
	return CheckGrant(grant, toolName, target, now)
}

// CheckGrant is the pure authorization resolver: it mirrors the TS
// @crowe/code-capability check() exactly and is the function the shared
// conformance vectors test. Order: sensitive-path deny first (no grant may
// promote past it), then no grant / expired / tool-absent / target-mismatch all
// fall back to the default ask, an explicit deny wins, otherwise the granted
// mode applies.
func CheckGrant(grant *CapabilityGrant, toolName, target string, now time.Time) CheckResult {
	if target != "" && IsSensitivePath(target) {
		return CheckResult{Mode: ModeDeny, Reason: "sensitive path"}
	}
	if grant == nil {
		return CheckResult{Mode: DefaultMode, Reason: "no grant"}
	}
	if grant.ExpiresAt != nil && now.After(*grant.ExpiresAt) {
		return CheckResult{Mode: DefaultMode, Reason: "grant expired"}
	}
	mode, ok := grant.Tools[toolName]
	if !ok {
		return CheckResult{Mode: DefaultMode, Reason: "tool not in grant"}
	}
	if mode == ModeDeny {
		return CheckResult{Mode: ModeDeny, Reason: "explicitly denied"}
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
		if MatchGlob(p, target) {
			return true
		}
	}
	return false
}
