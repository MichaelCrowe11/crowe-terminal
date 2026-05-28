// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import (
	"context"
	"sync"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const View_McpUi = "mcpui"

// blockOps is the injectable seam over block lifecycle RPCs so tests never hit
// the wsh transport.
type blockOps interface {
	findTab(ctx context.Context, blockID string) (string, error)
	create(ctx context.Context, tabID, targetBlockID string, meta map[string]any) (blockID string, err error)
	setMeta(ctx context.Context, blockID string, meta map[string]any) error
}

type wshBlockOps struct{}

func (wshBlockOps) findTab(ctx context.Context, blockID string) (string, error) {
	return wstore.DBFindTabForBlockId(ctx, blockID)
}

func (wshBlockOps) create(ctx context.Context, tabID, targetBlockID string, meta map[string]any) (string, error) {
	data := wshrpc.CommandCreateBlockData{
		TabId:         tabID,
		BlockDef:      &waveobj.BlockDef{Meta: meta},
		TargetBlockId: targetBlockID,
		TargetAction:  "splitright",
		Focused:       true,
	}
	oref, err := wshclient.CreateBlockCommand(wshclient.GetBareRpcClient(), data, &wshrpc.RpcOpts{Route: wshutil.DefaultRoute})
	if err != nil {
		return "", err
	}
	return oref.OID, nil
}

func (wshBlockOps) setMeta(ctx context.Context, blockID string, meta map[string]any) error {
	data := wshrpc.CommandSetMetaData{
		ORef: waveobj.MakeORef(waveobj.OType_Block, blockID),
		Meta: meta,
	}
	return wshclient.SetMetaCommand(wshclient.GetBareRpcClient(), data, &wshrpc.RpcOpts{Route: wshutil.DefaultRoute})
}

// blockRenderer surfaces MCP-UI HTML in a single mcpui-view block keyed by
// (session, tool). First render creates the block split off the calling block;
// later renders update that block's meta in place.
type blockRenderer struct {
	callingBlockID string
	session        string
	tool           string
	ops            blockOps

	mu      sync.Mutex
	blockID string
}

func makeBlockRenderer(callingBlockID, session, tool string) *blockRenderer {
	return &blockRenderer{
		callingBlockID: callingBlockID,
		session:        session,
		tool:           tool,
		ops:            wshBlockOps{},
	}
}

func (r *blockRenderer) Render(ctx context.Context, html string) (string, error) {
	r.mu.Lock()
	defer r.mu.Unlock()

	if r.blockID != "" {
		err := r.ops.setMeta(ctx, r.blockID, map[string]any{waveobj.MetaKey_McpUiHTML: html})
		if err != nil {
			return "", err
		}
		return r.blockID, nil
	}

	tabID, err := r.ops.findTab(ctx, r.callingBlockID)
	if err != nil {
		return "", err
	}
	meta := map[string]any{
		waveobj.MetaKey_View:        View_McpUi,
		waveobj.MetaKey_McpUiHTML:    html,
		waveobj.MetaKey_McpUiSession: r.session,
		waveobj.MetaKey_McpUiTool:    r.tool,
	}
	blockID, err := r.ops.create(ctx, tabID, r.callingBlockID, meta)
	if err != nil {
		return "", err
	}
	r.blockID = blockID
	return blockID, nil
}
