// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package system

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func TestMetricsRegistered(t *testing.T) {
	tool, ok := registry.Default().Get("system.metrics")
	if !ok {
		t.Fatalf("system.metrics not registered")
	}
	if tool.Mutating {
		t.Fatalf("system.metrics should be non-mutating")
	}
}

func TestMetricsHandlerReturnsSnapshot(t *testing.T) {
	res, err := handleMetrics(context.Background(), json.RawMessage(`{"topn":3}`))
	if err != nil {
		t.Fatalf("handler: %v", err)
	}
	if res.IsError {
		t.Fatalf("unexpected error: %s", res.ErrorText)
	}
	var snap MetricsSnapshot
	if err := json.Unmarshal(res.Content, &snap); err != nil {
		t.Fatalf("unmarshal snapshot: %v", err)
	}
	if snap.TS == 0 {
		t.Fatalf("expected ts to be set")
	}
	if snap.MemTotalGB <= 0 {
		t.Fatalf("expected mem_total_gb > 0, got %v", snap.MemTotalGB)
	}
	if len(snap.TopProc) > 3 {
		t.Fatalf("topn cap not honored: %d", len(snap.TopProc))
	}
}

func TestMetricsHandlerInvalidArgs(t *testing.T) {
	res, _ := handleMetrics(context.Background(), json.RawMessage(`{"topn":"oops"}`))
	if !res.IsError {
		t.Fatalf("expected IsError on bad input")
	}
}
