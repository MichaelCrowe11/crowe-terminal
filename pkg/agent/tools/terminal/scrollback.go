// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
	"github.com/wavetermdev/waveterm/pkg/wshrpc/wshclient"
	"github.com/wavetermdev/waveterm/pkg/wshutil"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	defaultScrollbackCount = 200
	maxScrollbackCount     = 1000
)

const SchemaReadScrollback = `{
  "type": "object",
  "properties": {
    "blockid": {"type":"string","minLength":1,"description":"Terminal block id (8-character prefix or full id). Use terminal.list_blocks to discover."},
    "line_start": {"type":"integer","minimum":0,"default":0,"description":"Logical start index where 0 is the most recent line."},
    "count": {"type":"integer","minimum":1,"maximum":1000,"default":200,"description":"Maximum number of lines to return."},
    "last_command": {"type":"boolean","default":false,"description":"Return only the most recent command output. Requires shell integration."}
  },
  "required":["blockid"],
  "additionalProperties":false
}`

type readScrollbackArgs struct {
	BlockID     string `json:"blockid"`
	LineStart   int    `json:"line_start"`
	Count       int    `json:"count"`
	LastCommand bool   `json:"last_command"`
}

type scrollbackCommandInfo struct {
	Command  string `json:"command"`
	Status   string `json:"status"`
	ExitCode *int   `json:"exitcode,omitempty"`
}

type readScrollbackResult struct {
	BlockID            string                 `json:"blockid"`
	TotalLines         int                    `json:"total_lines"`
	LineStart          int                    `json:"line_start"`
	LineEnd            int                    `json:"line_end"`
	ReturnedLines      int                    `json:"returned_lines"`
	Content            string                 `json:"content"`
	SinceLastOutputSec *int                   `json:"since_last_output_sec,omitempty"`
	HasMore            bool                   `json:"has_more"`
	NextStart          *int                   `json:"next_start,omitempty"`
	LastCommand        *scrollbackCommandInfo `json:"last_command,omitempty"`
}

func init() {
	registry.Register(&registry.Tool{
		Name: "terminal.read_scrollback",
		Description: "Read scrollback from a user-visible terminal block. Returns the most recent 200 lines by default, " +
			"with pagination plus last-command status when shell integration is available.",
		Schema:   json.RawMessage(SchemaReadScrollback),
		Mutating: false,
		Handler:  handleReadScrollback,
	})
}

func handleReadScrollback(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args readScrollbackArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return terminalErrResult(fmt.Errorf("invalid arguments: %w", err)), nil
	}
	if args.BlockID == "" {
		return terminalErrResult(fmt.Errorf("blockid required")), nil
	}
	if args.LineStart < 0 {
		return terminalErrResult(fmt.Errorf("line_start must be non-negative")), nil
	}
	if args.Count == 0 {
		args.Count = defaultScrollbackCount
	}
	if args.Count < 0 {
		return terminalErrResult(fmt.Errorf("count must be positive")), nil
	}
	if args.Count > maxScrollbackCount {
		args.Count = maxScrollbackCount
	}

	blockID, err := resolveTerminalBlock(ctx, args.BlockID)
	if err != nil {
		return terminalErrResult(err), nil
	}
	if args.LastCommand {
		blockORef := waveobj.MakeORef(waveobj.OType_Block, blockID)
		rtInfo := wstore.GetRTInfo(blockORef)
		if rtInfo == nil || !rtInfo.ShellIntegration {
			return terminalErrResult(fmt.Errorf("shell integration is not enabled for terminal %s", blockID)), nil
		}
	}
	rpcData := wshrpc.CommandTermGetScrollbackLinesData{
		LineStart:   args.LineStart,
		LineEnd:     args.LineStart + args.Count,
		LastCommand: args.LastCommand,
	}
	if args.LastCommand {
		rpcData.LineStart = 0
		rpcData.LineEnd = 0
	}

	cli := wshclient.GetBareRpcClient()
	result, err := wshclient.TermGetScrollbackLinesCommand(cli, rpcData, &wshrpc.RpcOpts{
		Route:   wshutil.MakeFeBlockRouteId(blockID),
		Timeout: 5000,
	})
	if err != nil {
		return terminalErrResult(fmt.Errorf("read terminal scrollback: %w", err)), nil
	}

	body, err := json.Marshal(buildScrollbackResult(blockID, rpcData, result, time.Now()))
	if err != nil {
		return terminalErrResult(err), nil
	}
	return registry.Result{Content: body}, nil
}

func buildScrollbackResult(blockID string, request wshrpc.CommandTermGetScrollbackLinesData, result *wshrpc.CommandTermGetScrollbackLinesRtnData, now time.Time) readScrollbackResult {
	lineEnd := result.LineStart + len(result.Lines)
	hasMore := !request.LastCommand && lineEnd < result.TotalLines

	var nextStart *int
	if hasMore {
		next := lineEnd
		nextStart = &next
	}
	var sinceLastOutputSec *int
	if result.LastUpdated > 0 {
		seconds := max(0, int((now.UnixMilli()-result.LastUpdated)/1000))
		sinceLastOutputSec = &seconds
	}

	var lastCommand *scrollbackCommandInfo
	blockORef := waveobj.MakeORef(waveobj.OType_Block, blockID)
	if rtInfo := wstore.GetRTInfo(blockORef); rtInfo != nil && rtInfo.ShellIntegration && rtInfo.ShellLastCmd != "" {
		lastCommand = &scrollbackCommandInfo{Command: rtInfo.ShellLastCmd}
		switch rtInfo.ShellState {
		case "running-command":
			lastCommand.Status = "running"
		case "ready":
			lastCommand.Status = "completed"
			exitCode := rtInfo.ShellLastCmdExitCode
			lastCommand.ExitCode = &exitCode
		default:
			lastCommand.Status = rtInfo.ShellState
		}
	}

	return readScrollbackResult{
		BlockID:            blockID,
		TotalLines:         result.TotalLines,
		LineStart:          result.LineStart,
		LineEnd:            lineEnd,
		ReturnedLines:      len(result.Lines),
		Content:            strings.Join(result.Lines, "\n"),
		SinceLastOutputSec: sinceLastOutputSec,
		HasMore:            hasMore,
		NextStart:          nextStart,
		LastCommand:        lastCommand,
	}
}

func resolveTerminalBlock(ctx context.Context, idOrPrefix string) (string, error) {
	if block, _ := wstore.DBGet[*waveobj.Block](ctx, idOrPrefix); block != nil {
		return assertTerminalView(block)
	}
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return "", err
	}
	var match string
	for _, block := range blocks {
		if block == nil || block.Meta == nil || !strings.HasPrefix(block.OID, idOrPrefix) {
			continue
		}
		view, _ := block.Meta[waveobj.MetaKey_View].(string)
		if view != "term" {
			continue
		}
		if match != "" {
			return "", fmt.Errorf("terminal block prefix %q is ambiguous", idOrPrefix)
		}
		match = block.OID
	}
	if match == "" {
		return "", fmt.Errorf("no terminal block found matching %q", idOrPrefix)
	}
	return match, nil
}

func assertTerminalView(block *waveobj.Block) (string, error) {
	view, _ := block.Meta[waveobj.MetaKey_View].(string)
	if view != "term" {
		return "", fmt.Errorf("block %s is view=%q, expected 'term'", block.OID, view)
	}
	return block.OID, nil
}

func terminalErrResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}
