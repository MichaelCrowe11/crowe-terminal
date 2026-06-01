// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package mcpui detects and models MCP-UI resources embedded in MCP tool
// results, so the host can render them as interactive blocks.
package mcpui

const (
	// UISchemePrefix marks an embedded resource as an MCP-UI payload.
	UISchemePrefix = "ui://"
	// MimeHTML is the phase-1 supported UI payload type.
	MimeHTML = "text/html"
	// MimeRemoteDOM is reserved for phase 2; phase-1 Detect rejects it.
	MimeRemoteDOM = "application/vnd.mcp-ui.remote-dom"
)

// UIResource is a resolved, renderable MCP-UI payload.
type UIResource struct {
	URI      string
	MimeType string
	HTML     string // inline HTML for MimeHTML payloads
}
