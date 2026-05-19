// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package editorctx holds the renderer's snapshot of the currently focused
// Crowe Code editor, per tab. wshserver writes to this store when the
// renderer reports a focus / cursor / selection change; agent tools read
// from it when they need to answer "what is the user looking at?" without
// the user copy-pasting.
//
// Keeping this in its own package avoids a circular import between the
// wshrpc/wshserver implementation (which receives the renderer report) and
// the agent tool registry (which reads it). Both depend on this package;
// neither depends on the other.
package editorctx

import "sync"

// ActiveEditor mirrors the renderer's snapshot. Line and column fields are
// 1-indexed (Monaco convention).
type ActiveEditor struct {
	TabId                string
	BlockId              string
	FilePath             string
	LanguageId           string
	CursorLine           int
	CursorColumn         int
	SelectionStartLine   int
	SelectionStartColumn int
	SelectionEndLine     int
	SelectionEndColumn   int
	HasSelection         bool
}

var store sync.Map // map[string]*ActiveEditor — key is TabId

// Set stores or replaces the active editor for a tab. Passing nil clears.
func Set(tabId string, ae *ActiveEditor) {
	if tabId == "" {
		return
	}
	if ae == nil {
		store.Delete(tabId)
		return
	}
	clone := *ae
	clone.TabId = tabId
	store.Store(tabId, &clone)
}

// Get returns the most recently reported active editor for a tab, or nil
// if nothing is currently focused.
func Get(tabId string) *ActiveEditor {
	if tabId == "" {
		return nil
	}
	v, ok := store.Load(tabId)
	if !ok || v == nil {
		return nil
	}
	rec := v.(*ActiveEditor)
	cp := *rec
	return &cp
}

// Clear deletes the slot for a tab. Equivalent to Set(tabId, nil) but more
// readable at call sites that explicitly want to forget state.
func Clear(tabId string) {
	if tabId == "" {
		return
	}
	store.Delete(tabId)
}
