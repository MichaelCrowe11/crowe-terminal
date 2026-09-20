// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package terminal

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/events"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/blockcontroller"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

const proposalTab = "11111111-1111-4111-8111-111111111111"
const proposalOtherTab = "22222222-2222-4222-8222-222222222222"
const proposalBlock = "b248deda-1111-4111-8111-111111111111"
const proposalOtherBlock = "c248deda-2222-4222-8222-222222222222"

type proposalFixture struct {
	store     terminalStore
	blocks    map[string]*waveobj.Block
	tab       *waveobj.Tab
	inputs    []*blockcontroller.BlockInputUnion
	sentIDs   []string
	events    []events.Event
	lookupErr error
	sendErr   error
}

func makeProposalFixture() *proposalFixture {
	f := &proposalFixture{
		blocks: map[string]*waveobj.Block{
			proposalBlock:      {OID: proposalBlock, Meta: waveobj.MetaMapType{"view": "term", "controller": "shell"}},
			proposalOtherBlock: {OID: proposalOtherBlock, Meta: waveobj.MetaMapType{"view": "term", "controller": "shell"}},
		},
		tab: &waveobj.Tab{OID: proposalTab, BlockIds: []string{proposalBlock}},
	}
	f.store = terminalStore{
		getBlock: func(_ context.Context, id string) (*waveobj.Block, error) { return f.blocks[id], f.lookupErr },
		getTab: func(_ context.Context, id string) (*waveobj.Tab, error) {
			if id != f.tab.OID {
				return nil, errors.New("tab not found")
			}
			return f.tab, f.lookupErr
		},
		findTab: func(context.Context, string) (string, error) { return f.tab.OID, f.lookupErr },
	}
	return f
}

func (f *proposalFixture) deps() proposalDependencies {
	return proposalDependencies{
		store: f.store,
		prepareSender: func(id, connection string) (func(context.Context, *blockcontroller.BlockInputUnion) error, error) {
			return func(_ context.Context, input *blockcontroller.BlockInputUnion) error {
				if f.sendErr != nil {
					return f.sendErr
				}
				f.sentIDs = append(f.sentIDs, id)
				f.inputs = append(f.inputs, input)
				return nil
			}, nil
		},
		publish: func(e events.Event) { f.events = append(f.events, e) },
	}
}

func proposalContext() context.Context { return scope.WithTabID(context.Background(), proposalTab) }
func proposalRaw(id, command string) json.RawMessage {
	raw, _ := json.Marshal(proposeArgs{BlockID: id, Command: command})
	return raw
}

func TestTerminalProposalResolution(t *testing.T) {
	for _, id := range []string{proposalBlock, proposalBlock[:8]} {
		t.Run(id, func(t *testing.T) {
			f := makeProposalFixture()
			p, err := prepareCommand(proposalContext(), proposalRaw(id, "pwd"), f.deps())
			if err != nil || p.BlockID() != proposalBlock || p.TabID() != proposalTab {
				t.Fatalf("proposal=%v err=%v", p, err)
			}
			if len(f.inputs) != 0 || len(f.events) != 0 {
				t.Fatal("preparation had effects")
			}
		})
	}
	for _, mode := range []string{"ambiguous", "cross-tab", "wrong-view", "missing", "no-scope", "db-error", "caller-moved"} {
		t.Run(mode, func(t *testing.T) {
			f := makeProposalFixture()
			ctx, id := proposalContext(), proposalBlock[:8]
			switch mode {
			case "ambiguous":
				collision := "b248deda-9999-4999-8999-999999999999"
				f.tab.BlockIds = append(f.tab.BlockIds, collision)
				f.blocks[collision] = &waveobj.Block{OID: collision, Meta: waveobj.MetaMapType{"view": "web"}}
			case "cross-tab":
				id = proposalOtherBlock
			case "wrong-view":
				f.blocks[proposalBlock].Meta["view"] = "web"
			case "missing":
				delete(f.blocks, proposalBlock)
			case "no-scope":
				ctx = context.Background()
			case "db-error":
				f.lookupErr = errors.New("lookup failed")
			case "caller-moved":
				ctx = scope.WithBlockID(ctx, proposalOtherBlock)
				f.store.findTab = func(context.Context, string) (string, error) { return proposalOtherTab, nil }
			}
			if _, err := prepareCommand(ctx, proposalRaw(id, "pwd"), f.deps()); err == nil {
				t.Fatal("expected rejection")
			}
			if len(f.inputs) != 0 || len(f.events) != 0 {
				t.Fatal("invalid target had effects")
			}
		})
	}
}

func TestTerminalProposalExactBytesOnce(t *testing.T) {
	for _, command := range []string{"pwd", "  printf '%s' 'héllo 世界'  ", `printf '%s' '\n'`, "echo 😀", "echo العربية", "echo 👩‍💻"} {
		f := makeProposalFixture()
		p, err := prepareCommand(proposalContext(), proposalRaw(proposalBlock[:8], command), f.deps())
		if err != nil {
			t.Fatal(err)
		}
		res, err := p.Execute(proposalContext())
		if err != nil || res.IsError {
			t.Fatalf("result=%+v err=%v", res, err)
		}
		if len(f.inputs) != 1 || string(f.inputs[0].InputData) != command || f.inputs[0].SigName != "" || f.inputs[0].TermSize != nil {
			t.Fatalf("input=%+v", f.inputs)
		}
		if !reflect.DeepEqual(f.sentIDs, []string{proposalBlock}) || res.PendingID != proposalBlock {
			t.Fatal("noncanonical send/result")
		}
		if len(f.events) != 1 || f.events[0].BlockID != proposalBlock || !strings.Contains(string(f.events[0].Payload), proposalBlock) {
			t.Fatal("noncanonical event")
		}
		res, _ = p.Execute(proposalContext())
		if !res.IsError || len(f.inputs) != 1 {
			t.Fatal("duplicate execution")
		}
	}
}

func TestTerminalProposalControlRejection(t *testing.T) {
	commands := []string{"", "pwd\n", "pwd\r", "a\tb", "a\x00b", "a\x1bb", "a\x7fb", "ab", "a b", "a b", string([]byte{0xff})}
	for _, r := range []rune{0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069} {
		commands = append(commands, "echo "+string(r)+"hidden")
	}
	for _, command := range commands {
		if err := ValidateCommand(command); err == nil {
			t.Fatalf("accepted %q", command)
		}
		if command == string([]byte{0xff}) {
			continue
		}
		res, err := handleProposeCommand(proposalContext(), proposalRaw(proposalBlock, command))
		if err != nil || !res.IsError {
			t.Fatalf("handler accepted %q", command)
		}
	}
	for _, raw := range []json.RawMessage{
		json.RawMessage(`{"blockid":"x","command":"\ud800"}`),
		json.RawMessage(`{"blockid":"x","command":"\udc00"}`),
		json.RawMessage(`{"blockid":"x","command":"\ud800A"}`),
		append([]byte(`{"command":"`), 0xff, '"', '}'),
	} {
		res, _ := handleProposeCommand(proposalContext(), raw)
		if !res.IsError {
			t.Fatalf("accepted malformed unicode %q", raw)
		}
	}
	for _, raw := range []json.RawMessage{json.RawMessage(`{"command":"😀"}`), json.RawMessage(`{"command":"\\ud800"}`)} {
		if err := validateProposalJSON(raw); err != nil {
			t.Fatal(err)
		}
	}
}

func TestTerminalProposalPendingChanges(t *testing.T) {
	for _, mode := range []string{"deleted", "moved", "view", "connection", "controller", "prefix-reused", "canceled", "send-error", "db-error"} {
		t.Run(mode, func(t *testing.T) {
			f := makeProposalFixture()
			ctx, cancel := context.WithCancel(proposalContext())
			defer cancel()
			p, err := prepareCommand(ctx, proposalRaw(proposalBlock[:8], "pwd"), f.deps())
			if err != nil {
				t.Fatal(err)
			}
			switch mode {
			case "deleted":
				delete(f.blocks, proposalBlock)
			case "moved":
				f.tab.BlockIds = nil
			case "view":
				f.blocks[proposalBlock].Meta["view"] = "web"
			case "connection":
				f.blocks[proposalBlock].Meta["connection"] = "ssh:other"
			case "controller":
				f.blocks[proposalBlock].Meta["controller"] = "cmd"
			case "prefix-reused":
				f.tab.BlockIds = []string{"b248deda-9999-4999-8999-999999999999"}
			case "canceled":
				cancel()
			case "send-error":
				f.sendErr = errors.New("sink error")
			case "db-error":
				f.lookupErr = errors.New("lookup error")
			}
			res, err := p.Execute(ctx)
			if err != nil || !res.IsError {
				t.Fatalf("result=%+v err=%v", res, err)
			}
			if len(f.inputs) != 0 || len(f.events) != 0 {
				t.Fatal("changed pending proposal had effects")
			}
		})
	}
}

func TestTerminalProposalRejectsBeforeSender(t *testing.T) {
	f := makeProposalFixture()
	deps := f.deps()
	prepared := 0
	deps.prepareSender = func(string, string) (func(context.Context, *blockcontroller.BlockInputUnion) error, error) {
		prepared++
		return nil, errors.New("sender must not be prepared")
	}
	for _, r := range []rune{0x00, 0x09, 0x0a, 0x0d, 0x1b, 0x7f, 0x85, 0x2028, 0x2029, 0x061c, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069} {
		if _, err := prepareCommand(proposalContext(), proposalRaw(proposalBlock, "pwd"+string(r)), deps); err == nil {
			t.Fatalf("accepted U+%04X", r)
		}
	}
	if prepared != 0 || len(f.inputs) != 0 || len(f.events) != 0 {
		t.Fatal("invalid command reached sender")
	}
}

func TestTerminalProposalScopedListing(t *testing.T) {
	f := makeProposalFixture()
	res, err := listBlocks(proposalContext(), json.RawMessage(`{}`), f.store)
	if err != nil || res.IsError {
		t.Fatalf("%+v %v", res, err)
	}
	var body struct {
		Blocks []blockInfo `json:"blocks"`
	}
	if err := json.Unmarshal(res.Content, &body); err != nil {
		t.Fatal(err)
	}
	if len(body.Blocks) != 1 || body.Blocks[0].BlockID != proposalBlock {
		t.Fatalf("unscoped listing: %+v", body)
	}
	res, _ = listBlocks(context.Background(), json.RawMessage(`{}`), f.store)
	if !res.IsError {
		t.Fatal("listing without scope succeeded")
	}
}
