// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"sort"
	"sync"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/scope"
)

var defaultRegistry = MakeRegistry()

type Registry struct {
	lock  sync.RWMutex
	tools map[string]*Tool
}

func MakeRegistry() *Registry {
	return &Registry{tools: make(map[string]*Tool)}
}

func Default() *Registry {
	return defaultRegistry
}

func Register(t *Tool) {
	defaultRegistry.Register(t)
}

func (r *Registry) Register(t *Tool) {
	if t == nil || t.Name == "" || t.Handler == nil {
		return
	}
	r.lock.Lock()
	defer r.lock.Unlock()
	r.tools[t.Name] = t
}

func (r *Registry) Get(name string) (*Tool, bool) {
	r.lock.RLock()
	defer r.lock.RUnlock()
	t, ok := r.tools[name]
	return t, ok
}

func (r *Registry) List() []*Tool {
	r.lock.RLock()
	defer r.lock.RUnlock()
	out := make([]*Tool, 0, len(r.tools))
	for _, t := range r.tools {
		out = append(out, t)
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Name < out[j].Name })
	return out
}

func (r *Registry) Catalog() []CatalogEntry {
	tools := r.List()
	entries := make([]CatalogEntry, 0, len(tools))
	for _, t := range tools {
		entry := CatalogEntry{Type: "function", Mutating: t.Mutating}
		entry.Function.Name = t.Name
		entry.Function.Description = t.Description
		entry.Function.Parameters = t.Schema
		entries = append(entries, entry)
	}
	return entries
}

func (r *Registry) Call(ctx context.Context, req CallRequest) (Result, error) {
	t, ok := r.Get(req.Name)
	if !ok {
		return Result{IsError: true, ErrorText: fmt.Sprintf("unknown tool: %s", req.Name)},
			fmt.Errorf("unknown tool: %s", req.Name)
	}
	args := req.Arguments
	if len(args) == 0 {
		args = json.RawMessage("{}")
	}
	if blocked, denial := r.scopeCheck(ctx, t, args, req.ToolCallID); blocked {
		return denial, nil
	}
	return t.Handler(ctx, args)
}

// scopeCheck consults the per-block grant store when a block id is present in
// the request context. Calls without a block id (legacy in-process callers,
// startup probes, tests) are passed through unchanged so the rollout of
// scoping is incremental rather than a flag day.
//
// ModeDeny short-circuits the call with an error result. ModeAsk currently
// allows the call but logs a warning so the audit trail captures what would
// have prompted; a follow-up change will surface an actual approval UI on
// the calling block.
func (r *Registry) scopeCheck(ctx context.Context, t *Tool, args json.RawMessage, toolCallID string) (bool, Result) {
	blockID, ok := scope.BlockIDFromContext(ctx)
	if !ok {
		return false, Result{}
	}
	sessionID, _ := scope.AgentSessionIDFromContext(ctx)
	target := ""
	if t.TargetExtractor != nil {
		target = t.TargetExtractor(args)
	}
	decision := scope.Check(scope.DefaultStore(), blockID, sessionID, t.Name, target, time.Now())
	switch decision.Mode {
	case scope.ModeDeny:
		log.Printf("[agent-scope] DENY block=%s session=%s tool=%s target=%q reason=%s call=%s\n",
			blockID, sessionID, t.Name, target, decision.Reason, toolCallID)
		return true, Result{
			IsError:   true,
			ErrorText: fmt.Sprintf("scope: %s denied for this block (%s)", t.Name, decision.Reason),
		}
	case scope.ModeAsk:
		log.Printf("[agent-scope] ASK  block=%s session=%s tool=%s target=%q reason=%s call=%s\n",
			blockID, sessionID, t.Name, target, decision.Reason, toolCallID)
	}
	return false, Result{}
}
