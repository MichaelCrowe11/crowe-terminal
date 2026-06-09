// Copyright 2026, Crowe Logic, Inc.
// SPDX-License-Identifier: Apache-2.0

package openaichat

import (
	"fmt"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
)

func makeTools(n int) []uctypes.ToolDefinition {
	tools := make([]uctypes.ToolDefinition, n)
	for i := 0; i < n; i++ {
		tools[i] = uctypes.ToolDefinition{Name: fmt.Sprintf("tool_%d", i)}
	}
	return tools
}

func TestCapToolsForModel(t *testing.T) {
	cases := []struct {
		name      string
		input     int
		wantLen   int
		wantFirst string
		wantLast  string
	}{
		{"under limit", 50, 50, "tool_0", "tool_49"},
		{"at limit", maxOpenAIChatTools, maxOpenAIChatTools, "tool_0", "tool_127"},
		{"over limit drops tail", 158, maxOpenAIChatTools, "tool_0", "tool_127"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := capToolsForModel(makeTools(tc.input), "crowelm-auto")
			if len(got) != tc.wantLen {
				t.Fatalf("len = %d, want %d", len(got), tc.wantLen)
			}
			if got[0].Name != tc.wantFirst {
				t.Errorf("first = %q, want %q", got[0].Name, tc.wantFirst)
			}
			if got[len(got)-1].Name != tc.wantLast {
				t.Errorf("last = %q, want %q (tail must be dropped, not the head)", got[len(got)-1].Name, tc.wantLast)
			}
		})
	}
}

func TestCapToolsForModelNilSafe(t *testing.T) {
	if got := capToolsForModel(nil, "crowelm-auto"); got != nil {
		t.Fatalf("nil input should pass through, got len %d", len(got))
	}
}
