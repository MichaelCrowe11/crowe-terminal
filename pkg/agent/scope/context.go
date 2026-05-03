// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package scope

import (
	"context"
	"sync"
)

type ctxKey int

const (
	ctxKeyBlockID ctxKey = iota
	ctxKeyAgentSessionID
)

// WithBlockID stamps a block id onto the request context. Tool transports
// (HTTP, MCP, in-process) call this before dispatching into Registry.Call so
// the registry knows whose grant to consult. A context with no block id is
// treated as "out-of-band caller" and bypasses scope checks: this preserves
// behavior for legacy callers that have not yet been migrated.
func WithBlockID(ctx context.Context, blockID string) context.Context {
	if blockID == "" {
		return ctx
	}
	return context.WithValue(ctx, ctxKeyBlockID, blockID)
}

func BlockIDFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	v, ok := ctx.Value(ctxKeyBlockID).(string)
	return v, ok && v != ""
}

func WithAgentSessionID(ctx context.Context, sessionID string) context.Context {
	if sessionID == "" {
		return ctx
	}
	return context.WithValue(ctx, ctxKeyAgentSessionID, sessionID)
}

func AgentSessionIDFromContext(ctx context.Context) (string, bool) {
	if ctx == nil {
		return "", false
	}
	v, ok := ctx.Value(ctxKeyAgentSessionID).(string)
	return v, ok && v != ""
}

var (
	defaultStoreOnce sync.Once
	defaultStore     *MemoryStore
)

// DefaultStore returns the process-wide grant store. The registry consults
// this store when a tool call carries a block id in context.
func DefaultStore() *MemoryStore {
	defaultStoreOnce.Do(func() {
		defaultStore = MakeMemoryStore()
	})
	return defaultStore
}
