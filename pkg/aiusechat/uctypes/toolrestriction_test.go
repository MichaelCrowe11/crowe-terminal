// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uctypes

import "testing"

func TestTerminalApprovalSmokeToolRestriction(t *testing.T) {
	defs := []ToolDefinition{{Name: "terminal_exec_safe"}, {Name: "read_text_file"}, {Name: "widget_focus"}, {Name: "terminal_propose_command"}, {Name: "terminal_list_blocks"}}
	opts := WaveChatOpts{Tools: defs[:2], TabTools: defs[2:]}
	for _, name := range []string{"terminal_exec_safe", "read_text_file", "widget_focus", "fabricated", "terminal.propose_command"} {
		if def := opts.getToolDefinition(name, true); def != nil {
			t.Fatalf("restricted tool exposed: %s", name)
		}
	}
	for _, name := range []string{"terminal_propose_command", "terminal_list_blocks"} {
		if def := opts.getToolDefinition(name, true); def == nil {
			t.Fatalf("allowed tool missing: %s", name)
		}
	}
	for _, def := range defs {
		if opts.getToolDefinition(def.Name, false) == nil {
			t.Fatalf("default tool missing: %s", def.Name)
		}
	}
	filtered := filterToolCatalog(defs, true)
	if len(filtered) != 2 || filtered[0].Name != "terminal_propose_command" || filtered[1].Name != "terminal_list_blocks" {
		t.Fatalf("wrong catalog: %+v", filtered)
	}
	if len(defs) != 5 || len(filterToolCatalog(defs, false)) != 5 {
		t.Fatal("default catalog changed")
	}
}
