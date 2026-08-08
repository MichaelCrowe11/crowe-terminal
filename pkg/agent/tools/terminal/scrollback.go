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
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
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
	// line_start/line_end are physical buffer rows, but result.Lines holds logical
	// lines: the frontend joins wrapped rows and trims trailing blanks. Advancing the
	// cursor by len(Lines) would under-advance it, so paginate on the requested row
	// span instead (matching pkg/aiusechat/tools_term.go).
	lineEnd := result.LineStart + len(result.Lines)
	if !request.LastCommand {
		lineEnd = min(request.LineEnd, result.TotalLines)
	}
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

// Resolution is confined to the calling agent's own tab. A global scan would let an
// agent embedded in one tab read terminal output from another tab or workspace, which
// is the user's data from a session it was never invited into.
func resolveTerminalBlock(ctx context.Context, idOrPrefix string) (string, error) {
	idOrPrefix = strings.TrimSpace(idOrPrefix)
	if idOrPrefix == "" {
		return "", fmt.Errorf("blockid required")
	}
	blockIDs, err := callerTabBlockIDs(ctx)
	if err != nil {
		return "", err
	}
	var match string
	for _, blockID := range blockIDs {
		if !strings.HasPrefix(blockID, idOrPrefix) {
			continue
		}
		block, _ := wstore.DBGet[*waveobj.Block](ctx, blockID)
		if block == nil || block.Meta == nil {
			continue
		}
		if view, _ := block.Meta[waveobj.MetaKey_View].(string); view != "term" {
			if blockID == idOrPrefix {
				return "", fmt.Errorf("block %s is view=%q, expected 'term'", blockID, view)
			}
			continue
		}
		if blockID == idOrPrefix {
			return blockID, nil
		}
		if match != "" {
			return "", fmt.Errorf("terminal block prefix %q is ambiguous in this tab", idOrPrefix)
		}
		match = blockID
	}
	if match == "" {
		return "", fmt.Errorf("no terminal block matching %q in the calling tab", idOrPrefix)
	}
	return match, nil
}

func callerTabBlockIDs(ctx context.Context) ([]string, error) {
	callerBlockID, ok := scope.BlockIDFromContext(ctx)
	if !ok {
		return nil, fmt.Errorf("no calling block in context; this tool requires an embedded agent")
	}
	tabID, err := wstore.DBFindTabForBlockId(ctx, callerBlockID)
	if err != nil {
		return nil, fmt.Errorf("resolve tab for calling block %s: %w", callerBlockID, err)
	}
	tab, err := wstore.DBMustGet[*waveobj.Tab](ctx, tabID)
	if err != nil {
		return nil, fmt.Errorf("get tab %s: %w", tabID, err)
	}
	return tab.BlockIds, nil
}

func terminalErrResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}
