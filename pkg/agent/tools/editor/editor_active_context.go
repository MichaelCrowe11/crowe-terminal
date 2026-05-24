// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package editor

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/agent/editorctx"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "editor.get_active_context",
		Description: "Return what the user is currently looking at: the active " +
			"Crowe Code editor's file path, cursor position, selection, and " +
			"language. Returns empty=true when no editor has focus. Read-only. " +
			"Call this before answering questions like 'what does this do?', " +
			"'rename this function', or 'fix this' so you know what 'this' is.",
		Schema:   json.RawMessage(schemaGetActiveContext),
		Mutating: false,
		Handler:  handleGetActiveContext,
	})
}

const schemaGetActiveContext = `{
  "type": "object",
  "properties": {},
  "additionalProperties": false
}`

type activeContextRtn struct {
	Empty                bool   `json:"empty"`
	FilePath             string `json:"filepath,omitempty"`
	BlockId              string `json:"blockid,omitempty"`
	LanguageId           string `json:"languageid,omitempty"`
	CursorLine           int    `json:"cursorline,omitempty"`
	CursorColumn         int    `json:"cursorcolumn,omitempty"`
	SelectionStartLine   int    `json:"selectionstartline,omitempty"`
	SelectionStartColumn int    `json:"selectionstartcolumn,omitempty"`
	SelectionEndLine     int    `json:"selectionendline,omitempty"`
	SelectionEndColumn   int    `json:"selectionendcolumn,omitempty"`
	HasSelection         bool   `json:"hasselection,omitempty"`
}

func handleGetActiveContext(ctx context.Context, _ json.RawMessage) (registry.Result, error) {
	blockID, ok := scope.BlockIDFromContext(ctx)
	if !ok {
		return errResult(fmt.Errorf("no calling block in context")), nil
	}
	tabID, err := wstore.DBFindTabForBlockId(ctx, blockID)
	if err != nil {
		return errResult(fmt.Errorf("cannot resolve tab for block %s: %w", blockID, err)), nil
	}
	ae := editorctx.Get(tabID)
	rtn := activeContextRtn{}
	if ae == nil {
		rtn.Empty = true
	} else {
		rtn.FilePath = ae.FilePath
		rtn.BlockId = ae.BlockId
		rtn.LanguageId = ae.LanguageId
		rtn.CursorLine = ae.CursorLine
		rtn.CursorColumn = ae.CursorColumn
		rtn.SelectionStartLine = ae.SelectionStartLine
		rtn.SelectionStartColumn = ae.SelectionStartColumn
		rtn.SelectionEndLine = ae.SelectionEndLine
		rtn.SelectionEndColumn = ae.SelectionEndColumn
		rtn.HasSelection = ae.HasSelection
	}
	body, err := json.Marshal(rtn)
	if err != nil {
		return errResult(fmt.Errorf("marshal active-context: %w", err)), nil
	}
	return registry.Result{Content: body}, nil
}
