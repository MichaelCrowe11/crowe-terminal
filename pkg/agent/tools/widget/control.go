// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package widget

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const schemaBlockControl = `{
  "type":"object",
  "properties": {
    "blockid": {"type":"string","minLength":1,"description":"Block id (8-character prefix or full id). Use terminal.list_blocks to discover."}
  },
  "required":["blockid"],
  "additionalProperties":false
}`

type blockControlArgs struct {
	BlockID string `json:"blockid"`
}

func init() {
	registry.Register(&registry.Tool{
		Name:        "widget.capture_screenshot",
		Description: "Capture the visible pixels of any Hypheus block. Returns a PNG data URL for terminal, editor, browser, system, and other visible block types.",
		Schema:      json.RawMessage(schemaBlockControl),
		Mutating:    false,
		Handler:     handleCaptureScreenshot,
	})
	registry.Register(&registry.Tool{
		Name:        "widget.focus",
		Description: "Focus a visible Hypheus block so keyboard input and subsequent operator actions target it.",
		Schema:      json.RawMessage(schemaBlockControl),
		Mutating:    true,
		Handler:     handleFocus,
	})
}

func handleCaptureScreenshot(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	blockID, tabID, failure := resolveBlockControlArgs(ctx, raw)
	if failure != nil {
		return *failure, nil
	}
	cli := wshclient.GetBareRpcClient()
	dataURL, err := wshclient.CaptureBlockScreenshotCommand(
		cli,
		wshrpc.CommandCaptureBlockScreenshotData{BlockId: blockID},
		&wshrpc.RpcOpts{Route: wshutil.MakeTabRouteId(tabID), Timeout: 10000},
	)
	if err != nil {
		return errResult(fmt.Errorf("capture block screenshot: %w", err)), nil
	}
	body, err := json.Marshal(map[string]any{
		"blockid":        blockID,
		"tabid":          tabID,
		"image_data_url": dataURL,
	})
	if err != nil {
		return errResult(err), nil
	}
	return registry.Result{Content: body}, nil
}

func handleFocus(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	blockID, tabID, failure := resolveBlockControlArgs(ctx, raw)
	if failure != nil {
		return *failure, nil
	}
	cli := wshclient.GetBareRpcClient()
	if err := wshclient.SetBlockFocusCommand(cli, blockID, &wshrpc.RpcOpts{
		Route: wshutil.MakeTabRouteId(tabID), Timeout: 3000,
	}); err != nil {
		return errResult(fmt.Errorf("focus block: %w", err)), nil
	}
	body, _ := json.Marshal(map[string]any{
		"focused": true,
		"blockid": blockID,
		"tabid":   tabID,
	})
	return registry.Result{Content: body}, nil
}

func resolveBlockControlArgs(ctx context.Context, raw json.RawMessage) (string, string, *registry.Result) {
	var args blockControlArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		failure := errResult(fmt.Errorf("invalid arguments: %w", err))
		return "", "", &failure
	}
	blockID, err := resolveAnyBlock(ctx, args.BlockID)
	if err != nil {
		failure := errResult(err)
		return "", "", &failure
	}
	tabID, err := wstore.DBFindTabForBlockId(ctx, blockID)
	if err != nil {
		failure := errResult(fmt.Errorf("resolve tab for block %s: %w", blockID, err))
		return "", "", &failure
	}
	return blockID, tabID, nil
}

func resolveAnyBlock(ctx context.Context, idOrPrefix string) (string, error) {
	idOrPrefix = strings.TrimSpace(idOrPrefix)
	if idOrPrefix == "" {
		return "", fmt.Errorf("blockid required")
	}
	if block, _ := wstore.DBGet[*waveobj.Block](ctx, idOrPrefix); block != nil {
		return block.OID, nil
	}
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return "", err
	}
	var match string
	for _, block := range blocks {
		if block == nil || !strings.HasPrefix(block.OID, idOrPrefix) {
			continue
		}
		if match != "" {
			return "", fmt.Errorf("block prefix %q is ambiguous", idOrPrefix)
		}
		match = block.OID
	}
	if match == "" {
		return "", fmt.Errorf("no block found matching %q", idOrPrefix)
	}
	return match, nil
}
