// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
)

const (
	KindMutating    = "mutating"
	KindNonMutating = "non_mutating"

	BlockTypeTerminal = "term"
	BlockTypeBrowser  = "web"
	BlockTypeSysmon   = "sysinfo"
	BlockTypeAI       = "waveai"
	BlockTypeAny      = ""
)

type Tool struct {
	Name        string          `json:"name"`
	Description string          `json:"description"`
	Schema      json.RawMessage `json:"parameters"`
	Mutating    bool            `json:"mutating"`
	DefaultBlk  string          `json:"defaultblock,omitempty"`
	Handler     Handler         `json:"-"`

	// TargetExtractor optionally pulls a "target" string from the call args
	// (typically a file path, URL, or block id) so per-block grants can
	// scope by glob. Tools without a meaningful target leave this nil; the
	// registry then matches against any TargetPatterns the grant declares.
	TargetExtractor func(args json.RawMessage) string `json:"-"`
}

type Handler func(ctx context.Context, args json.RawMessage) (Result, error)

type Result struct {
	Content   json.RawMessage `json:"content,omitempty"`
	IsError   bool            `json:"iserror,omitempty"`
	ErrorText string          `json:"errortext,omitempty"`
	Pending   bool            `json:"pending,omitempty"`
	PendingID string          `json:"pendingid,omitempty"`
}

type CallRequest struct {
	Name       string          `json:"name"`
	Arguments  json.RawMessage `json:"arguments"`
	ToolCallID string          `json:"toolcallid,omitempty"`

	// BlockID and AgentSessionID identify the calling agent context so
	// per-block grants (pkg/agent/scope) can be applied. Both are optional;
	// requests that omit them bypass scope checks (legacy passthrough).
	BlockID        string `json:"blockid,omitempty"`
	AgentSessionID string `json:"agentsessionid,omitempty"`
}

type CatalogEntry struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
	Mutating bool `json:"x_mutating,omitempty"`
}
