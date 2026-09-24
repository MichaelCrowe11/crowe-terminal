// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"encoding/json"
	"fmt"
	"strconv"
	"sync/atomic"
	"unicode"
	"unicode/utf8"

	"github.com/wavetermdev/waveterm/pkg/agent/events"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const SchemaProposeCommand = `{
  "type": "object",
  "properties": {
    "blockid": {"type": "string", "description": "Full UUID or unique prefix of a terminal block in the calling tab. Use terminal.list_blocks to discover."},
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
			"The user approves typing the exact command, then separately presses Enter in the terminal. " +
			"Only printable command text is accepted; terminal controls and line separators are rejected.",
		Schema:   json.RawMessage(SchemaProposeCommand),
		Mutating: true,
		Handler:  handleProposeCommand,
	})
	registry.Register(&registry.Tool{
		Name:        "terminal.list_blocks",
		Description: "List blocks in the calling tab. Returns full block UUIDs and views so the model can target a propose_command call.",
		Schema:      json.RawMessage(SchemaListBlocks),
		Mutating:    false,
		Handler:     handleListBlocks,
	})
}

type proposalDependencies struct {
	store         terminalStore
	prepareSender func(string, string) (func(context.Context, *blockcontroller.BlockInputUnion) error, error)
	publish       func(events.Event)
}

func defaultProposalDependencies() proposalDependencies {
	return proposalDependencies{
		store:         defaultTerminalStore,
		prepareSender: blockcontroller.PrepareInputSender,
		publish: func(event events.Event) {
			if agentEventHub != nil {
				agentEventHub.Publish(event)
			}
		},
	}
}

// PreparedCommand is runtime-only. Its private values cannot be reconstructed
// from an approval preview or modified by later model input.
type PreparedCommand struct {
	command    string
	blockID    string
	tabID      string
	connection string
	controller string
	deps       proposalDependencies
	send       func(context.Context, *blockcontroller.BlockInputUnion) error
	used       atomic.Bool
}

func (p *PreparedCommand) Command() string    { return p.command }
func (p *PreparedCommand) BlockID() string    { return p.blockID }
func (p *PreparedCommand) TabID() string      { return p.tabID }
func (p *PreparedCommand) Connection() string { return p.connection }

func ValidateCommand(command string) error {
	if command == "" {
		return fmt.Errorf("command required")
	}
	if !utf8.ValidString(command) {
		return fmt.Errorf("command must be valid UTF-8")
	}
	for _, r := range command {
		if unicode.IsControl(r) || unicode.Is(unicode.Bidi_Control, r) || r == 0x2028 || r == 0x2029 {
			return fmt.Errorf("command contains terminal control, bidi control, or line separator U+%04X", r)
		}
	}
	return nil
}

// encoding/json replaces invalid UTF-8 and lone UTF-16 surrogates with U+FFFD.
// Reject them before decoding so approval never silently rewrites command text.
func validateProposalJSON(raw json.RawMessage) error {
	if !utf8.Valid(raw) || !json.Valid(raw) {
		return fmt.Errorf("invalid proposal JSON or UTF-8")
	}
	for i := 0; i < len(raw); i++ {
		if raw[i] != '\\' {
			continue
		}
		i++
		if raw[i] != 'u' {
			continue
		}
		v, _ := strconv.ParseUint(string(raw[i+1:i+5]), 16, 16)
		i += 4
		if v >= 0xdc00 && v <= 0xdfff {
			return fmt.Errorf("unpaired Unicode surrogate")
		}
		if v < 0xd800 || v > 0xdbff {
			continue
		}
		if i+6 >= len(raw) || raw[i+1] != '\\' || raw[i+2] != 'u' {
			return fmt.Errorf("unpaired Unicode surrogate")
		}
		low, err := strconv.ParseUint(string(raw[i+3:i+7]), 16, 16)
		if err != nil || low < 0xdc00 || low > 0xdfff {
			return fmt.Errorf("unpaired Unicode surrogate")
		}
		i += 6
	}
	return nil
}

func PrepareCommand(ctx context.Context, raw json.RawMessage) (*PreparedCommand, error) {
	return prepareCommand(ctx, raw, defaultProposalDependencies())
}

func prepareCommand(ctx context.Context, raw json.RawMessage, deps proposalDependencies) (*PreparedCommand, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := validateProposalJSON(raw); err != nil {
		return nil, err
	}
	var args proposeArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, fmt.Errorf("invalid arguments: %w", err)
	}
	if err := ValidateCommand(args.Command); err != nil {
		return nil, err
	}
	tabID, block, err := deps.store.resolve(ctx, args.BlockID)
	if err != nil {
		return nil, err
	}
	connection := block.Meta.GetString(waveobj.MetaKey_Connection, "")
	if connection != "" {
		if err := ValidateCommand(connection); err != nil {
			return nil, fmt.Errorf("invalid terminal connection label: %w", err)
		}
	}
	send, err := deps.prepareSender(block.OID, connection)
	if err != nil {
		return nil, err
	}
	return &PreparedCommand{
		command: args.Command, blockID: block.OID, tabID: tabID,
		connection: connection, controller: block.Meta.GetString(waveobj.MetaKey_Controller, ""),
		deps: deps, send: send,
	}, nil
}

func (p *PreparedCommand) Execute(ctx context.Context) (registry.Result, error) {
	if !p.used.CompareAndSwap(false, true) {
		return terminalErrResult(fmt.Errorf("terminal proposal already consumed")), nil
	}
	tabID, block, err := p.deps.store.resolve(ctx, p.blockID)
	if err != nil {
		return terminalErrResult(err), nil
	}
	if tabID != p.tabID || block.OID != p.blockID ||
		block.Meta.GetString(waveobj.MetaKey_Connection, "") != p.connection ||
		block.Meta.GetString(waveobj.MetaKey_Controller, "") != p.controller {
		return terminalErrResult(fmt.Errorf("terminal proposal destination changed")), nil
	}
	if err := ctx.Err(); err != nil {
		return terminalErrResult(err), nil
	}
	input := &blockcontroller.BlockInputUnion{InputData: []byte(p.command)}
	if err := p.send(ctx, input); err != nil {
		return terminalErrResult(fmt.Errorf("send input: %w", err)), nil
	}
	payload, _ := json.Marshal(map[string]any{"blockid": p.blockID, "command": p.command})
	p.deps.publish(events.Event{Kind: events.KindCommandProposed, BlockID: p.blockID, Payload: payload})
	out, _ := json.Marshal(map[string]any{
		"proposed": true, "blockid": p.blockID, "command": p.command,
		"awaits": "user_enter", "hint": "Command text was typed without Enter. Press Enter separately in the terminal to submit it.",
	})
	return registry.Result{Content: out, Pending: true, PendingID: p.blockID}, nil
}

func handleProposeCommand(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	prepared, err := PrepareCommand(ctx, raw)
	if err != nil {
		return terminalErrResult(err), nil
	}
	return prepared.Execute(ctx)
}

func handleListBlocks(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	return listBlocks(ctx, raw, defaultTerminalStore)
}

func listBlocks(ctx context.Context, raw json.RawMessage, store terminalStore) (registry.Result, error) {
	var args listArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return terminalErrResult(err), nil
		}
	}
	_, blockIDs, err := store.callerTab(ctx)
	if err != nil {
		return terminalErrResult(err), nil
	}
	infos := make([]blockInfo, 0, len(blockIDs))
	for _, blockID := range blockIDs {
		b, err := store.getBlock(ctx, blockID)
		if err != nil {
			return terminalErrResult(err), nil
		}
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
