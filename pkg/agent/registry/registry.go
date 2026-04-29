// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"fmt"
	"sort"
	"sync"
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
	return t.Handler(ctx, args)
}
