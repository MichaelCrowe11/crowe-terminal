// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/wavetermdev/waveterm/pkg/agent/events"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const SchemaProposeCommand = `{
  "type": "object",
  "properties": {
    "blockid": {"type": "string", "description": "ID of the terminal block to type into. Use terminal.list_blocks to discover."},
    "command": {"type": "string", "minLength": 1, "description": "Shell command to type. The newline is NOT sent — the user must press Enter."}
  },
  "required": ["blockid","command"],
  "additionalProperties": false
}`

const SchemaListBlocks = `{
  "type": "object",
  "properties": {
    "view": {"type": "string", "enum": ["term","web","sysinfo","waveai",""], "description": "Filter by block view. Empty = all."}
  },
  "additionalProperties": false
}`

type proposeArgs struct {
	BlockID string `json:"blockid"`
	Command string `json:"command"`
}

type listArgs struct {
	View string `json:"view"`
}

type blockInfo struct {
	BlockID    string `json:"blockid"`
	View       string `json:"view"`
	Controller string `json:"controller,omitempty"`
	Title      string `json:"title,omitempty"`
}

// agentEventHub is the package's reference to the running agent's event
// hub. Set by the agent package after init to avoid an import cycle.
var agentEventHub *events.Hub

func SetEventHub(h *events.Hub) { agentEventHub = h }

func init() {
	registry.Register(&registry.Tool{
		Name: "terminal.propose_command",
		Description: "Type a command into a user-visible terminal block but DO NOT press Enter. " +
			"Use this for any mutating shell command — the user reviews the typed line and " +
			"presses Enter (or rejects) via the AI block's action card.",
		Schema:   json.RawMessage(SchemaProposeCommand),
		Mutating: true,
		Handler:  handleProposeCommand,
	})
	registry.Register(&registry.Tool{
		Name:        "terminal.list_blocks",
		Description: "List blocks in the current workspace. Returns blockid + view so the model can target a propose_command call.",
		Schema:      json.RawMessage(SchemaListBlocks),
		Mutating:    false,
		Handler:     handleListBlocks,
	})
}

func handleProposeCommand(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args proposeArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return registry.Result{IsError: true, ErrorText: "invalid arguments: " + err.Error()}, nil
	}
	if args.BlockID == "" || args.Command == "" {
		return registry.Result{IsError: true, ErrorText: "blockid and command required"}, nil
	}
	block, err := wstore.DBGet[*waveobj.Block](ctx, args.BlockID)
	if err != nil || block == nil {
		return registry.Result{IsError: true, ErrorText: "block not found: " + args.BlockID}, nil
	}
	view := ""
	if block.Meta != nil {
		view = block.Meta.GetString(waveobj.MetaKey_View, "")
	}
	if view != "term" {
		return registry.Result{
			IsError:   true,
			ErrorText: fmt.Sprintf("block %s is view=%q, expected 'term'", args.BlockID, view),
		}, nil
	}
	input := &blockcontroller.BlockInputUnion{InputData: []byte(args.Command)}
	if err := blockcontroller.SendInput(args.BlockID, input); err != nil {
		return registry.Result{IsError: true, ErrorText: "send input: " + err.Error()}, nil
	}
	if agentEventHub != nil {
		payload, _ := json.Marshal(map[string]any{
			"blockid": args.BlockID,
			"command": args.Command,
		})
		agentEventHub.Publish(events.Event{
			Kind:    events.KindCommandProposed,
			BlockID: args.BlockID,
			Payload: payload,
		})
	}
	out, _ := json.Marshal(map[string]any{
		"proposed":     true,
		"blockid":      args.BlockID,
		"command":      args.Command,
		"awaits":       "user_enter",
		"hint":         "The command is typed but not run. The user must press Enter or reject via the action card.",
	})
	return registry.Result{Content: out, Pending: true, PendingID: args.BlockID}, nil
}

func handleListBlocks(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args listArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &args)
	}
	blocks, err := wstore.DBGetAllObjsByType[*waveobj.Block](ctx, waveobj.OType_Block)
	if err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	infos := make([]blockInfo, 0, len(blocks))
	for _, b := range blocks {
		if b == nil || b.Meta == nil {
			continue
		}
		view := b.Meta.GetString(waveobj.MetaKey_View, "")
		if args.View != "" && view != args.View {
			continue
		}
		infos = append(infos, blockInfo{
			BlockID:    b.OID,
			View:       view,
			Controller: b.Meta.GetString(waveobj.MetaKey_Controller, ""),
			Title:      b.Meta.GetString("title", ""),
		})
	}
	body, _ := json.Marshal(map[string]any{"blocks": infos})
	return registry.Result{Content: body}, nil
}
