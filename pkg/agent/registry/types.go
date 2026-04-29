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
