// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"context"
	"fmt"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/aiusechat/uctypes"
	"github.com/wavetermdev/waveterm/pkg/web/sse"
)

type ApprovalRequest struct {
	approval       string
	done           bool
	doneChan       chan struct{}
	mu             sync.Mutex
	ctx            context.Context
	stopCancel     func() bool
	onCloseUnregFn func()
}

func (req *ApprovalRequest) updateApproval(approval string) error {
	req.mu.Lock()
	defer req.mu.Unlock()
	if req.done {
		return fmt.Errorf("tool approval already decided")
	}
	if req.ctx.Err() != nil && approval != uctypes.ApprovalCanceled {
		return fmt.Errorf("tool approval canceled")
	}
	req.approval = approval
	req.done = true
	close(req.doneChan)
	return nil
}

func (req *ApprovalRequest) decision() string {
	req.mu.Lock()
	defer req.mu.Unlock()
	return req.approval
}

type ApprovalRegistry struct {
	mu       sync.Mutex
	requests map[string]*ApprovalRequest
	reserved map[string]bool
}

var globalApprovalRegistry = &ApprovalRegistry{
	requests: make(map[string]*ApprovalRequest),
	reserved: make(map[string]bool),
}

func registerToolApprovalRequest(toolCallId string, req *ApprovalRequest) error {
	globalApprovalRegistry.mu.Lock()
	defer globalApprovalRegistry.mu.Unlock()
	if toolCallId == "" {
		return fmt.Errorf("tool call id required")
	}
	if globalApprovalRegistry.reserved[toolCallId] {
		return fmt.Errorf("tool call id already used: %s", toolCallId)
	}
	// Keep only IDs for the process lifetime: expiring them would let an old
	// approval card authorize a later request that reuses the same provider ID.
	globalApprovalRegistry.reserved[toolCallId] = true
	globalApprovalRegistry.requests[toolCallId] = req
	return nil
}

func removeToolApprovalRequest(toolCallId string) *ApprovalRequest {
	globalApprovalRegistry.mu.Lock()
	defer globalApprovalRegistry.mu.Unlock()
	req := globalApprovalRegistry.requests[toolCallId]
	delete(globalApprovalRegistry.requests, toolCallId)
	return req
}

func UnregisterToolApproval(toolCallId string) {
	req := removeToolApprovalRequest(toolCallId)
	if req != nil {
		req.stopCancel()
		req.onCloseUnregFn()
		_ = req.updateApproval(uctypes.ApprovalCanceled)
	}
}

func getToolApprovalRequest(toolCallId string) (*ApprovalRequest, bool) {
	globalApprovalRegistry.mu.Lock()
	defer globalApprovalRegistry.mu.Unlock()
	req, exists := globalApprovalRegistry.requests[toolCallId]
	return req, exists
}

func RegisterToolApproval(toolCallId string, sseHandler *sse.SSEHandlerCh) error {
	ctx := sseHandler.Context()
	if err := ctx.Err(); err != nil {
		return err
	}
	req := &ApprovalRequest{doneChan: make(chan struct{}), ctx: ctx}
	req.stopCancel = context.AfterFunc(ctx, func() { _ = req.updateApproval(uctypes.ApprovalCanceled) })
	onCloseID := sseHandler.RegisterOnClose(func() { _ = req.updateApproval(uctypes.ApprovalCanceled) })
	req.onCloseUnregFn = func() { sseHandler.UnregisterOnClose(onCloseID) }
	if err := sseHandler.Err(); err != nil {
		req.stopCancel()
		req.onCloseUnregFn()
		return err
	}
	if err := registerToolApprovalRequest(toolCallId, req); err != nil {
		req.stopCancel()
		req.onCloseUnregFn()
		return err
	}
	return nil
}

func UpdateToolApproval(toolCallId string, approval string) error {
	if approval != uctypes.ApprovalUserApproved && approval != uctypes.ApprovalUserDenied {
		return fmt.Errorf("invalid tool approval decision %q", approval)
	}
	req, exists := getToolApprovalRequest(toolCallId)
	if !exists {
		return fmt.Errorf("tool approval is no longer active: %s", toolCallId)
	}
	return req.updateApproval(approval)
}

func WaitForToolApproval(ctx context.Context, toolCallId string) (string, error) {
	req, exists := getToolApprovalRequest(toolCallId)
	if !exists {
		return "", fmt.Errorf("tool approval is no longer active: %s", toolCallId)
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	select {
	case <-ctx.Done():
		return "", ctx.Err()
	case <-req.doneChan:
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	return req.decision(), nil
}
