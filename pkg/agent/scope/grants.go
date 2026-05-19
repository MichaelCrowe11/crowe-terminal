// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import "time"

// Common tool name prefixes used by helpers below. Kept here (not in
// individual tool packages) so the scope helpers do not import every tool
// package and create cycles.
const (
	PrefixEditor   = "editor."
	PrefixTerminal = "terminal."
	PrefixWeb      = "web."
	PrefixSystem   = "system."
	PrefixFarm     = "farm."
	PrefixWidget   = "widget."

	ToolEditorRead               = "editor.read_file"
	ToolEditorWrite              = "editor.write_file"
	ToolEditorEdit               = "editor.apply_edit"
	ToolEditorListRecent         = "editor.list_recent_files"
	ToolEditorGetActiveContext   = "editor.get_active_context"

	ToolWidgetOpenInCroweCode = "widget.open_in_crowecode"
)

// GrantPermissive installs an "allow everything" grant for a block. Use only
// for trusted contexts (the user's own AI panel, dev sessions). The grant has
// no target patterns, so any target on any tool passes.
func GrantPermissive(store Store, blockID, sessionID string) {
	if store == nil || blockID == "" || sessionID == "" {
		return
	}
	store.Put(&CapabilityGrant{
		BlockID:        blockID,
		AgentSessionID: sessionID,
		Tools:          permissiveTools(),
	})
}

// GrantReadOnly grants the block read-only file access scoped to a list of
// path globs (e.g., []string{"/Users/me/Projects/*", "/Users/me/Documents/*"}).
// Mutating editor tools are explicitly denied. widget.open_in_crowecode is
// allowed under the same path globs because opening a file as a UI tile is a
// read-shaped intent from the user's perspective even though it mutates
// workspace state.
func GrantReadOnly(store Store, blockID, sessionID string, pathGlobs []string) {
	if store == nil || blockID == "" || sessionID == "" {
		return
	}
	store.Put(&CapabilityGrant{
		BlockID:        blockID,
		AgentSessionID: sessionID,
		Tools: map[string]string{
			ToolEditorRead:             ModeAllow,
			ToolEditorListRecent:       ModeAllow,
			ToolEditorGetActiveContext: ModeAllow,
			ToolEditorWrite:            ModeDeny,
			ToolEditorEdit:             ModeDeny,
			ToolWidgetOpenInCroweCode:  ModeAllow,
		},
		TargetPatterns: map[string][]string{
			ToolEditorRead:            append([]string(nil), pathGlobs...),
			ToolWidgetOpenInCroweCode: append([]string(nil), pathGlobs...),
		},
	})
}

// GrantSandbox grants both read and write access scoped to a list of path
// globs. Outside the globs, write/edit calls fall through to ask (logged but
// allowed in v1; will prompt the user in a follow-up).
func GrantSandbox(store Store, blockID, sessionID string, pathGlobs []string) {
	if store == nil || blockID == "" || sessionID == "" {
		return
	}
	patterns := append([]string(nil), pathGlobs...)
	store.Put(&CapabilityGrant{
		BlockID:        blockID,
		AgentSessionID: sessionID,
		Tools: map[string]string{
			ToolEditorRead:             ModeAllow,
			ToolEditorWrite:            ModeAllow,
			ToolEditorEdit:             ModeAllow,
			ToolEditorListRecent:       ModeAllow,
			ToolEditorGetActiveContext: ModeAllow,
			ToolWidgetOpenInCroweCode:  ModeAllow,
		},
		TargetPatterns: map[string][]string{
			ToolEditorRead:            patterns,
			ToolEditorWrite:           patterns,
			ToolEditorEdit:            patterns,
			ToolWidgetOpenInCroweCode: patterns,
		},
	})
}

// GrantWithExpiry returns a copy of the grant scheduled to expire after d.
// Useful for one-shot agent runs that should not leave open capability
// behind. Callers should Put the result into the store.
func GrantWithExpiry(g *CapabilityGrant, d time.Duration) *CapabilityGrant {
	if g == nil {
		return nil
	}
	expires := time.Now().Add(d)
	out := *g
	out.ExpiresAt = &expires
	return &out
}

// SnapshotGrant returns the current grant for a block as a JSON-friendly map.
// Used by frontends to render the scope badge without leaking the Store
// interface across the RPC boundary.
func SnapshotGrant(store Store, blockID, sessionID string) map[string]any {
	if store == nil {
		return map[string]any{"granted": false, "reason": "no store"}
	}
	g, ok := store.Get(blockID, sessionID)
	if !ok {
		return map[string]any{"granted": false, "reason": "no grant"}
	}
	out := map[string]any{
		"granted":         true,
		"blockid":         g.BlockID,
		"agentsessionid":  g.AgentSessionID,
		"tools":           g.Tools,
		"targetpatterns":  g.TargetPatterns,
	}
	if g.ExpiresAt != nil {
		out["expiresat"] = g.ExpiresAt.UTC().Format(time.RFC3339)
	}
	return out
}

func permissiveTools() map[string]string {
	return map[string]string{
		ToolEditorRead:             ModeAllow,
		ToolEditorWrite:            ModeAllow,
		ToolEditorEdit:             ModeAllow,
		ToolEditorListRecent:       ModeAllow,
		ToolEditorGetActiveContext: ModeAllow,
		ToolWidgetOpenInCroweCode:  ModeAllow,
	}
}
