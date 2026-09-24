// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package waveadapter

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
)

const proposalTestBlock = "b248deda-1111-4111-8111-111111111111"
const proposalTestTab = "11111111-1111-4111-8111-111111111111"

type fakePreparedProposal struct {
	command    string
	executions int
}

func (p *fakePreparedProposal) Command() string    { return p.command }
func (p *fakePreparedProposal) BlockID() string    { return proposalTestBlock }
func (p *fakePreparedProposal) TabID() string      { return proposalTestTab }
func (p *fakePreparedProposal) Connection() string { return "" }
func (p *fakePreparedProposal) Execute(context.Context) (registry.Result, error) {
	p.executions++
	return registry.Result{Content: json.RawMessage(`{"typed":true}`)}, nil
}

func TestTerminalProposalAdapterBinding(t *testing.T) {
	for _, mode := range []string{"exact", "mutated-input", "mutated-preview", "replaced-preview", "history", "denied", "canceled", "cleanup", "call-id", "duplicate-preparation"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(scope.WithTabID(context.Background(), proposalTestTab))
			defer cancel()
			def := &uctypes.ToolDefinition{}
			p := &fakePreparedProposal{}
			bindTerminalProposal(ctx, def, func(ctx context.Context, raw json.RawMessage) (*fakePreparedProposal, error) {
				if tab, _ := scope.TabIDFromContext(ctx); tab != proposalTestTab {
					t.Fatal("lost trusted tab")
				}
				var args map[string]string
				if err := json.Unmarshal(raw, &args); err != nil {
					return nil, err
				}
				p.command = args["command"]
				return p, nil
			})
			input := map[string]any{"blockid": proposalTestBlock[:8], "command": "pwd"}
			data := &uctypes.UIMessageDataToolUse{ToolCallId: "call-1", Approval: uctypes.ApprovalNeedsApproval}
			if err := def.ToolVerifyInput(input, data); err != nil {
				t.Fatal(err)
			}
			if p.executions != 0 || data.TerminalProposal.Command != "pwd" || data.TerminalProposal.BlockId != proposalTestBlock {
				t.Fatal("bad preparation")
			}
			data.Approval = uctypes.ApprovalUserApproved
			switch mode {
			case "mutated-input":
				input["command"], input["blockid"] = "unexpected", "other"
			case "mutated-preview":
				data.TerminalProposal.Command = "unexpected"
			case "replaced-preview":
				data.TerminalProposal = &uctypes.TerminalProposal{Command: "pwd", BlockId: "other"}
			case "history":
				raw, _ := json.Marshal(data)
				data = &uctypes.UIMessageDataToolUse{}
				json.Unmarshal(raw, data)
			case "denied":
				data.Approval = uctypes.ApprovalUserDenied
			case "canceled":
				cancel()
			case "cleanup":
				def.ToolCallCleanup(data)
			case "call-id":
				data.ToolCallId = "call-2"
			case "duplicate-preparation":
				if err := def.ToolVerifyInput(input, data); err == nil {
					t.Fatal("duplicate preparation allowed")
				}
				def.ToolCallCleanup(data)
			}
			_, err := def.ToolAnyCallback(input, data)
			allowed := mode == "exact" || mode == "mutated-input"
			if allowed {
				if err != nil || p.executions != 1 || p.command != "pwd" {
					t.Fatalf("execution %d err=%v", p.executions, err)
				}
			} else if err == nil || p.executions != 0 {
				t.Fatalf("unsafe execution %d err=%v", p.executions, err)
			}
			if _, err := def.ToolAnyCallback(input, data); err == nil {
				t.Fatal("duplicate callback accepted")
			}
		})
	}
}

func TestTerminalProposalAdapterContext(t *testing.T) {
	ctx, cancel := context.WithCancel(scope.WithTabID(context.Background(), proposalTestTab))
	calls := 0
	def := wrap(ctx, &registry.Tool{Name: "fake.context", Handler: func(ctx context.Context, _ json.RawMessage) (registry.Result, error) {
		calls++
		if tab, _ := scope.TabIDFromContext(ctx); tab != proposalTestTab {
			t.Fatal("lost scope")
		}
		return registry.Result{Content: json.RawMessage(`{}`)}, nil
	}})
	if _, err := def.ToolAnyCallback(nil, nil); err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := def.ToolAnyCallback(nil, nil); err == nil || calls != 1 {
		t.Fatal("ignored cancellation")
	}
}
