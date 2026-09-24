// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"errors"
	"net/http/httptest"
	"os"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

type approvalTestBackend struct {
	UseChatBackend
	publish   func(uctypes.UIMessageDataToolUse) error
	snapshots []uctypes.UIMessageDataToolUse
	results   []uctypes.AIToolResult
	removed   []string
}

func (b *approvalTestBackend) UpdateToolUseData(_ string, _ string, data uctypes.UIMessageDataToolUse) error {
	b.snapshots = append(b.snapshots, data)
	if b.publish != nil {
		return b.publish(data)
	}
	return nil
}
func (b *approvalTestBackend) RemoveToolUseCall(_ string, id string) error {
	b.removed = append(b.removed, id)
	return nil
}
func (b *approvalTestBackend) ConvertToolResultsToNativeChatMessage(results []uctypes.AIToolResult) ([]uctypes.GenAIMessage, error) {
	b.results = append(b.results, results...)
	return nil, nil
}

func TestTerminalApprovalLifecycle(t *testing.T) {
	for _, mode := range []string{"approve-first-card", "deny", "cancel", "validation-error", "publication-error", "approved-publication-error", "sse-error"} {
		t.Run(mode, func(t *testing.T) {
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			h := sse.MakeSSEHandlerCh(httptest.NewRecorder(), ctx)
			verify, execute, cleanup := 0, 0, 0
			def := uctypes.ToolDefinition{
				Name:         "terminal_propose_command",
				ToolApproval: func(any) string { return uctypes.ApprovalNeedsApproval },
				ToolVerifyInput: func(_ any, data *uctypes.UIMessageDataToolUse) error {
					verify++
					if mode == "validation-error" {
						return errors.New("invalid input")
					}
					data.TerminalProposal = &uctypes.TerminalProposal{Command: "pwd", BlockId: "b248deda-1111-4111-8111-111111111111", TabId: "11111111-1111-4111-8111-111111111111", Connection: ""}
					return nil
				},
				ToolAnyCallback: func(_ any, data *uctypes.UIMessageDataToolUse) (any, error) {
					execute++
					if data.Approval != uctypes.ApprovalUserApproved {
						t.Fatal("execution without approval")
					}
					return map[string]any{"typed": "pwd"}, nil
				},
				ToolCallCleanup: func(*uctypes.UIMessageDataToolUse) { cleanup++ },
			}
			backend := &approvalTestBackend{}
			backend.publish = func(data uctypes.UIMessageDataToolUse) error {
				if data.Status == uctypes.ToolUseStatusPending && data.Approval == uctypes.ApprovalNeedsApproval {
					if verify != 1 || execute != 0 || data.TerminalProposal == nil || data.TerminalProposal.Command != "pwd" {
						t.Fatal("actionable card before preparation")
					}
					if mode == "publication-error" {
						return errors.New("storage failure")
					}
					if mode == "cancel" {
						cancel()
						return nil
					}
					decision := uctypes.ApprovalUserApproved
					if mode == "deny" {
						decision = uctypes.ApprovalUserDenied
					}
					if err := UpdateToolApproval(data.ToolCallId, decision); err != nil {
						t.Fatalf("first-card decision lost: %v", err)
					}
					if err := UpdateToolApproval(data.ToolCallId, decision); err == nil {
						t.Fatal("duplicate decision accepted")
					}
				}
				if mode == "approved-publication-error" && data.Approval == uctypes.ApprovalUserApproved {
					return errors.New("approved state failed")
				}
				return nil
			}
			if mode == "sse-error" {
				for i := 0; i < 10; i++ {
					if err := h.WriteData("occupied"); err != nil {
						t.Fatal(err)
					}
				}
			}
			stop := &uctypes.WaveStopReason{ToolCalls: []uctypes.WaveToolCall{{ID: uuid.NewString() + "-" + mode, Name: def.Name, Input: map[string]any{"command": "pwd"}}}}
			opts := uctypes.WaveChatOpts{Tools: []uctypes.ToolDefinition{def}}
			metrics := &uctypes.AIMetrics{ToolDetail: make(map[string]int)}
			_ = processAllToolCalls(backend, stop, opts, h, metrics, make(map[string]bool))
			want := 0
			if mode == "approve-first-card" {
				want = 1
			}
			if execute != want || verify != 1 || cleanup != 1 {
				t.Fatalf("verify=%d execute=%d cleanup=%d", verify, execute, cleanup)
			}
			if _, exists := getToolApprovalRequest(stop.ToolCalls[0].ID); exists {
				t.Fatal("approval leaked")
			}
			if err := UpdateToolApproval(stop.ToolCalls[0].ID, uctypes.ApprovalUserApproved); err == nil {
				t.Fatal("stale approval accepted")
			}
			if mode == "approve-first-card" {
				for _, data := range backend.snapshots {
					if data.TerminalProposal == nil || data.TerminalProposal.Command != "pwd" {
						t.Fatal("preview disappeared from snapshot")
					}
				}
			}
		})
	}
}

func TestTerminalApprovalDuplicateCalls(t *testing.T) {
	activeID := uuid.NewString()
	ctx := context.Background()
	h := sse.MakeSSEHandlerCh(httptest.NewRecorder(), ctx)
	backend := &approvalTestBackend{}
	seen := map[string]bool{"stale-call": true}
	for _, calls := range [][]uctypes.WaveToolCall{
		{{ID: "duplicate"}, {ID: "duplicate"}}, {{ID: ""}}, {{ID: "stale-call"}},
	} {
		if err := processAllToolCalls(backend, &uctypes.WaveStopReason{ToolCalls: calls}, uctypes.WaveChatOpts{}, h, &uctypes.AIMetrics{}, seen); err == nil {
			t.Fatal("duplicate call accepted")
		}
	}
	if len(backend.snapshots) != 0 {
		t.Fatal("duplicate calls published")
	}
	if err := RegisterToolApproval(activeID, h); err != nil {
		t.Fatal(err)
	}
	defer UnregisterToolApproval(activeID)
	original, _ := getToolApprovalRequest(activeID)
	if err := RegisterToolApproval(activeID, h); err == nil {
		t.Fatal("duplicate registration accepted")
	}
	if err := processAllToolCalls(backend, &uctypes.WaveStopReason{ToolCalls: []uctypes.WaveToolCall{{ID: activeID}}}, uctypes.WaveChatOpts{}, h, &uctypes.AIMetrics{}, seen); err == nil {
		t.Fatal("active ID accepted")
	}
	if req, _ := getToolApprovalRequest(activeID); req != original {
		t.Fatal("duplicate replaced original request")
	}
	if err := UpdateToolApproval(activeID, uctypes.ApprovalUserApproved); err != nil {
		t.Fatal(err)
	}
}

func TestTerminalApprovalCrossRequestReuse(t *testing.T) {
	for _, decision := range []string{uctypes.ApprovalUserApproved, uctypes.ApprovalUserDenied, uctypes.ApprovalCanceled} {
		t.Run(decision, func(t *testing.T) {
			id := uuid.NewString() + "-" + t.Name()
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			first := sse.MakeSSEHandlerCh(httptest.NewRecorder(), ctx)
			if err := RegisterToolApproval(id, first); err != nil {
				t.Fatal(err)
			}
			if decision == uctypes.ApprovalCanceled {
				cancel()
			} else if err := UpdateToolApproval(id, decision); err != nil {
				t.Fatal(err)
			}
			UnregisterToolApproval(id)
			second := sse.MakeSSEHandlerCh(httptest.NewRecorder(), context.Background())
			if err := RegisterToolApproval(id, second); err == nil {
				UnregisterToolApproval(id)
				t.Fatal("reused ID registered after cleanup")
			}
			if err := UpdateToolApproval(id, uctypes.ApprovalUserApproved); err == nil {
				t.Fatal("old card approved a replacement request")
			}
			executed := false
			def := uctypes.ToolDefinition{
				Name:         "terminal_propose_command",
				ToolApproval: func(any) string { return uctypes.ApprovalNeedsApproval },
				ToolAnyCallback: func(any, *uctypes.UIMessageDataToolUse) (any, error) {
					executed = true
					return nil, nil
				},
			}
			backend := &approvalTestBackend{}
			stop := &uctypes.WaveStopReason{ToolCalls: []uctypes.WaveToolCall{{ID: id, Name: def.Name, Input: map[string]any{}}}}
			if err := processAllToolCalls(backend, stop, uctypes.WaveChatOpts{Tools: []uctypes.ToolDefinition{def}}, second, &uctypes.AIMetrics{}, make(map[string]bool)); err == nil {
				t.Fatal("new chat request reused retired ID")
			}
			if executed || len(backend.snapshots) != 0 {
				t.Fatal("reused ID published or executed")
			}
			if _, exists := getToolApprovalRequest(id); exists {
				t.Fatal("replacement approval request leaked")
			}
		})
	}
}

type approvalResponseRecorder struct{ *httptest.ResponseRecorder }

func (w approvalResponseRecorder) SetWriteDeadline(time.Time) error { return nil }

func TestTerminalApprovalSSEClose(t *testing.T) {
	closedID, alreadyClosedID := uuid.NewString(), uuid.NewString()
	h := sse.MakeSSEHandlerCh(approvalResponseRecorder{httptest.NewRecorder()}, context.Background())
	if err := h.SetupSSE(); err != nil {
		t.Fatal(err)
	}
	if err := RegisterToolApproval(closedID, h); err != nil {
		t.Fatal(err)
	}
	defer UnregisterToolApproval(closedID)
	h.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	approval, err := WaitForToolApproval(ctx, closedID)
	if err != nil || approval != uctypes.ApprovalCanceled {
		t.Fatalf("closed approval=%q err=%v", approval, err)
	}
	if err := UpdateToolApproval(closedID, uctypes.ApprovalUserApproved); err == nil {
		t.Fatal("closed stream approved")
	}
	if err := RegisterToolApproval(alreadyClosedID, h); err == nil {
		UnregisterToolApproval(alreadyClosedID)
		t.Fatal("registered closed stream")
	}
}

func TestTerminalApprovalOrderedVerification(t *testing.T) {
	h := sse.MakeSSEHandlerCh(httptest.NewRecorder(), context.Background())
	created, verified, read := false, 0, false
	defs := []uctypes.ToolDefinition{
		{Name: "fake_write", ToolAnyCallback: func(any, *uctypes.UIMessageDataToolUse) (any, error) {
			created = true
			return "written", nil
		}},
		{Name: "fake_read", ToolVerifyInput: func(any, *uctypes.UIMessageDataToolUse) error {
			verified++
			if !created {
				return errors.New("file does not exist yet")
			}
			return nil
		}, ToolAnyCallback: func(any, *uctypes.UIMessageDataToolUse) (any, error) {
			read = true
			return "contents", nil
		}},
	}
	stop := &uctypes.WaveStopReason{ToolCalls: []uctypes.WaveToolCall{
		{ID: "ordered-write", Name: "fake_write", Input: map[string]any{}},
		{ID: "ordered-read", Name: "fake_read", Input: map[string]any{}},
	}}
	backend := &approvalTestBackend{}
	if err := processAllToolCalls(backend, stop, uctypes.WaveChatOpts{Tools: defs}, h, &uctypes.AIMetrics{ToolDetail: make(map[string]int)}, make(map[string]bool)); err != nil {
		t.Fatal(err)
	}
	if !created || !read || verified != 1 {
		t.Fatalf("created=%v read=%v verified=%d", created, read, verified)
	}
}

type smokeRestrictionBackend struct {
	approvalTestBackend
	calls int
}

func (b *smokeRestrictionBackend) RunChatStep(_ context.Context, _ *sse.SSEHandlerCh, opts uctypes.WaveChatOpts, _ *uctypes.WaveContinueResponse) (*uctypes.WaveStopReason, []uctypes.GenAIMessage, *uctypes.RateLimitInfo, error) {
	b.calls++
	if opts.AllowNativeWebSearch {
		return nil, nil, nil, errors.New("native web search still enabled")
	}
	for _, def := range append(opts.Tools, opts.TabTools...) {
		if def.Name != "terminal_list_blocks" && def.Name != "terminal_propose_command" {
			return nil, nil, nil, errors.New("forbidden catalog tool")
		}
	}
	return nil, nil, nil, nil
}

func TestTerminalApprovalSmokeProcess(t *testing.T) {
	if os.Getenv("CROWE_TERMINAL_APPROVAL_SMOKE") != "1" {
		t.Skip("requires startup smoke restriction")
	}
	calls := 0
	defs := []uctypes.ToolDefinition{}
	for _, name := range []string{"terminal_exec_safe", "read_text_file", "widget_focus", "fabricated", "terminal_list_blocks", "terminal_propose_command"} {
		defs = append(defs, uctypes.ToolDefinition{Name: name, ToolAnyCallback: func(any, *uctypes.UIMessageDataToolUse) (any, error) { calls++; return "fake", nil }})
	}
	opts := uctypes.WaveChatOpts{Tools: defs[:2], TabTools: defs[2:], AllowNativeWebSearch: true}
	for _, def := range defs[:4] {
		call := uctypes.WaveToolCall{ID: def.Name, Name: def.Name, Input: map[string]any{}}
		prepareToolCall(&call, opts)
		if call.ToolUseData.Status != uctypes.ToolUseStatusError || opts.GetToolDefinition(def.Name) != nil {
			t.Fatalf("prepared forbidden %s", def.Name)
		}
		if result := ResolveToolCall(&def, call, opts); result.ErrorText == "" {
			t.Fatalf("dispatched forbidden %s", def.Name)
		}
	}
	if calls != 0 {
		t.Fatal("forbidden handler ran")
	}
	for _, def := range defs[4:] {
		if result := ResolveToolCall(&def, uctypes.WaveToolCall{ID: def.Name, Name: def.Name}, opts); result.ErrorText != "" {
			t.Fatal(result.ErrorText)
		}
	}
	if calls != 2 {
		t.Fatal("allowed handlers missing")
	}
	backend := &smokeRestrictionBackend{}
	h := sse.MakeSSEHandlerCh(httptest.NewRecorder(), context.Background())
	if _, _, err := runAIChatStep(context.Background(), h, backend, opts, nil); err != nil {
		t.Fatal(err)
	}
	if backend.calls != 1 {
		t.Fatal("fake backend not called")
	}
}

func TestTerminalApprovalDecisions(t *testing.T) {
	id := uuid.NewString()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	h := sse.MakeSSEHandlerCh(httptest.NewRecorder(), ctx)
	if err := RegisterToolApproval(id, h); err != nil {
		t.Fatal(err)
	}
	defer UnregisterToolApproval(id)
	for _, decision := range []string{"", "auto-approved", "needs-approval", "canceled", "timeout", "unexpected"} {
		if err := UpdateToolApproval(id, decision); err == nil {
			t.Fatalf("accepted %q", decision)
		}
	}
	var wg sync.WaitGroup
	var mu sync.Mutex
	accepted := 0
	for _, decision := range []string{uctypes.ApprovalUserApproved, uctypes.ApprovalUserDenied} {
		wg.Add(1)
		go func(decision string) {
			defer wg.Done()
			if UpdateToolApproval(id, decision) == nil {
				mu.Lock()
				accepted++
				mu.Unlock()
			}
		}(decision)
	}
	wg.Wait()
	if accepted != 1 {
		t.Fatalf("accepted %d decisions", accepted)
	}
	if _, err := WaitForToolApproval(ctx, id); err != nil {
		t.Fatal(err)
	}
	cancel()
	if _, err := WaitForToolApproval(ctx, id); err == nil {
		t.Fatal("canceled wait approved")
	}
}
