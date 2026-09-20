// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package blockcontroller

import (
	"context"
	"encoding/base64"
	"sync"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/shellexec"
	"github.com/wavetermdev/waveterm/pkg/wshrpc"
)

func TestTerminalProposalPinnedShell(t *testing.T) {
	for _, mode := range []string{"exact", "process", "channel", "closed", "canceled", "stopped"} {
		t.Run(mode, func(t *testing.T) {
			ch := make(chan *BlockInputUnion, 1)
			sc := &ShellController{Lock: &sync.Mutex{}, ShellInputCh: ch, ShellProc: &shellexec.ShellProc{DoneCh: make(chan any)}, ProcStatus: Status_Running}
			send, err := sc.prepareInputSender()
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "process":
				sc.ShellProc = &shellexec.ShellProc{DoneCh: make(chan any)}
			case "channel":
				sc.ShellInputCh = make(chan *BlockInputUnion, 1)
			case "closed":
				close(ch)
			case "canceled":
				cancel()
			case "stopped":
				sc.ProcStatus = Status_Done
			}
			err = send(ctx, &BlockInputUnion{InputData: []byte("pwd")})
			if mode == "exact" {
				if err != nil {
					t.Fatal(err)
				}
				input := <-ch
				if string(input.InputData) != "pwd" || input.TermSize != nil || input.SigName != "" {
					t.Fatal("changed input")
				}
			} else if err == nil || len(ch) != 0 || len(sc.ShellInputCh) != 0 {
				t.Fatalf("unsafe send: %v", err)
			}
		})
	}
}

func TestTerminalProposalControllerReplacement(t *testing.T) {
	const blockID = "proposal-controller-replacement"
	original := &ShellController{Lock: &sync.Mutex{}, BlockId: blockID, ShellInputCh: make(chan *BlockInputUnion, 1), ShellProc: &shellexec.ShellProc{DoneCh: make(chan any)}, ProcStatus: Status_Running}
	set := func(controller Controller) {
		registryLock.Lock()
		defer registryLock.Unlock()
		controllerRegistry[blockID] = controller
	}
	set(original)
	defer deleteController(blockID)
	send, err := PrepareInputSender(blockID, "")
	if err != nil {
		t.Fatal(err)
	}
	replacement := &ShellController{Lock: &sync.Mutex{}, BlockId: blockID, ShellInputCh: make(chan *BlockInputUnion, 1), ShellProc: &shellexec.ShellProc{DoneCh: make(chan any)}, ProcStatus: Status_Running}
	set(replacement)
	if err := send(context.Background(), &BlockInputUnion{InputData: []byte("pwd")}); err == nil {
		t.Fatal("replacement controller accepted")
	}
	if len(original.ShellInputCh) != 0 || len(replacement.ShellInputCh) != 0 {
		t.Fatal("replacement had input")
	}
}

func TestTerminalProposalPinnedDurableJob(t *testing.T) {
	for _, mode := range []string{"exact", "job", "session", "canceled"} {
		t.Run(mode, func(t *testing.T) {
			dsc := &DurableShellController{Lock: &sync.Mutex{}, JobId: "job-original", InputSessionId: "session-original"}
			var inputs []wshrpc.CommandJobInputData
			send, err := dsc.prepareJobInputSender(func(_ context.Context, data wshrpc.CommandJobInputData) error {
				if !dsc.Lock.TryLock() {
					t.Fatal("lock held across side effect")
				}
				dsc.Lock.Unlock()
				inputs = append(inputs, data)
				return nil
			})
			if err != nil {
				t.Fatal(err)
			}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch mode {
			case "job":
				dsc.JobId = "job-new"
			case "session":
				dsc.InputSessionId = "session-new"
			case "canceled":
				cancel()
			}
			err = send(ctx, &BlockInputUnion{InputData: []byte("pwd")})
			if mode != "exact" {
				if err == nil || len(inputs) != 0 {
					t.Fatalf("unsafe job send: %v %+v", err, inputs)
				}
				return
			}
			if err != nil || len(inputs) != 1 {
				t.Fatalf("send: %v %+v", err, inputs)
			}
			data := inputs[0]
			input, _ := base64.StdEncoding.DecodeString(data.InputData64)
			if string(input) != "pwd" || data.JobId != "job-original" || data.InputSessionId != "session-original" || data.SeqNum != 1 || data.TermSize != nil || data.SigName != "" {
				t.Fatalf("changed job input: %+v", data)
			}
		})
	}
}
