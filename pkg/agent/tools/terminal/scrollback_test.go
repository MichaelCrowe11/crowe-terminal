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

// The frontend joins wrapped rows and trims trailing blanks, so it routinely returns
// fewer logical lines than the physical row span requested. Paginating on len(Lines)
// would report more data on a terminal the agent has already read in full, and on an
// all-blank buffer would hand back a cursor that never advances.
func TestBuildScrollbackResultDoesNotPaginateWhenWindowReachedEnd(t *testing.T) {
	cases := []struct {
		name       string
		lines      []string
		totalLines int
	}{
		{name: "trailing blanks trimmed", lines: []string{"a", "b", "c"}, totalLines: 40},
		{name: "wrapped rows joined", lines: []string{"one-very-long-logical-line"}, totalLines: 200},
		{name: "blank buffer returns nothing", lines: nil, totalLines: 40},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			result := buildScrollbackResult(
				"block-1",
				wshrpc.CommandTermGetScrollbackLinesData{LineStart: 0, LineEnd: 200},
				&wshrpc.CommandTermGetScrollbackLinesRtnData{
					Lines:      tc.lines,
					LineStart:  0,
					TotalLines: tc.totalLines,
				},
				time.Now(),
			)
			if result.HasMore || result.NextStart != nil {
				t.Fatalf("requested window covered the whole buffer, want has_more=false: %+v", result)
			}
			if result.LineEnd != tc.totalLines {
				t.Fatalf("line_end=%d, want %d (the requested span clamped to the buffer)", result.LineEnd, tc.totalLines)
			}
		})
	}
}

// A window that stops short of the buffer must still advance by the requested row
// span, not by the number of logical lines that came back.
func TestBuildScrollbackResultAdvancesByRequestedSpan(t *testing.T) {
	result := buildScrollbackResult(
		"block-1",
		wshrpc.CommandTermGetScrollbackLinesData{LineStart: 0, LineEnd: 100},
		&wshrpc.CommandTermGetScrollbackLinesRtnData{
			Lines:      []string{"wrapped-into-two-logical-lines", "second"},
			LineStart:  0,
			TotalLines: 500,
		},
		time.Now(),
	)
	if !result.HasMore || result.NextStart == nil {
		t.Fatalf("buffer has more rows, want has_more=true: %+v", result)
	}
	if *result.NextStart != 100 {
		t.Fatalf("next_start=%d, want 100 (requested span, not len(lines)=2)", *result.NextStart)
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
