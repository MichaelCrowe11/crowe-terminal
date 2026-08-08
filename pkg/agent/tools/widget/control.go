// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package widget

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
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
	blockID, tabID, err := resolveBlockInCallerTab(ctx, args.BlockID)
	if err != nil {
		failure := errResult(err)
		return "", "", &failure
	}
	return blockID, tabID, nil
}

// Resolution is confined to the calling agent's own tab. A global scan would let an
// agent embedded in one tab photograph or steal focus from another tab or workspace.
func resolveBlockInCallerTab(ctx context.Context, idOrPrefix string) (string, string, error) {
	idOrPrefix = strings.TrimSpace(idOrPrefix)
	if idOrPrefix == "" {
		return "", "", fmt.Errorf("blockid required")
	}
	callerBlockID, ok := scope.BlockIDFromContext(ctx)
	if !ok {
		return "", "", fmt.Errorf("no calling block in context; widget tools require an embedded agent")
	}
	tabID, err := wstore.DBFindTabForBlockId(ctx, callerBlockID)
	if err != nil {
		return "", "", fmt.Errorf("resolve tab for calling block %s: %w", callerBlockID, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabID)
	if err != nil {
		return "", "", fmt.Errorf("get tab %s: %w", tabID, err)
	}
	var match string
	for _, blockID := range tab.BlockIds {
		if !strings.HasPrefix(blockID, idOrPrefix) {
			continue
		}
		if blockID == idOrPrefix {
			return blockID, tabID, nil
		}
		if match != "" {
			return "", "", fmt.Errorf("block prefix %q is ambiguous in this tab", idOrPrefix)
		}
		match = blockID
	}
	if match == "" {
		return "", "", fmt.Errorf("no block matching %q in the calling tab", idOrPrefix)
	}
	return match, tabID, nil
}
