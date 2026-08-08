// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestReadScrollbackRegistered(t *testing.T) {
	tool, ok := registry.Default().Get("terminal.read_scrollback")
	if !ok {
		t.Fatal("terminal.read_scrollback not registered")
	}
	if tool.Mutating {
		t.Fatal("terminal.read_scrollback must be non-mutating")
	}
	var schema map[string]any
	if err := json.Unmarshal(tool.Schema, &schema); err != nil {
		t.Fatalf("invalid schema: %v", err)
	}
}

func TestBuildScrollbackResultPaginatesNewestFirst(t *testing.T) {
	now := time.Unix(1_700_000_005, 0)
	result := buildScrollbackResult(
		"block-1",
		wshrpc.CommandTermGetScrollbackLinesData{LineStart: 0, LineEnd: 2},
		&wshrpc.CommandTermGetScrollbackLinesRtnData{
			Lines:       []string{"newest", "older"},
			LineStart:   0,
			TotalLines:  8,
			LastUpdated: now.Add(-5 * time.Second).UnixMilli(),
		},
		now,
	)
	if result.Content != "newest\nolder" {
		t.Fatalf("content=%q", result.Content)
	}
	if result.LineEnd != 2 || result.ReturnedLines != 2 {
		t.Fatalf("line_end=%d returned=%d", result.LineEnd, result.ReturnedLines)
	}
	if !result.HasMore || result.NextStart == nil || *result.NextStart != 2 {
		t.Fatalf("pagination=%+v", result)
	}
	if result.SinceLastOutputSec == nil || *result.SinceLastOutputSec != 5 {
		t.Fatalf("since_last_output_sec=%v", result.SinceLastOutputSec)
	}
}

func TestBuildScrollbackResultLastCommandDoesNotPaginate(t *testing.T) {
	result := buildScrollbackResult(
		"block-1",
		wshrpc.CommandTermGetScrollbackLinesData{LastCommand: true},
		&wshrpc.CommandTermGetScrollbackLinesRtnData{
			Lines:      []string{"done"},
			TotalLines: 50,
		},
		time.Now(),
	)
	if result.HasMore || result.NextStart != nil {
		t.Fatalf("last-command output must not paginate: %+v", result)
	}
}
