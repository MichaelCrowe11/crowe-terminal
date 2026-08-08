// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// test-agent is a tiny harness that starts the Crowe Agent transport
// without the rest of wavesrv, so the Foundry-side proxy module can
// be exercised end-to-end from a Python integration test or shell.
//
// Usage:  WAVETERM_AUTH_KEY=demo CROWE_AGENT_PORT=18012 go run ./cmd/test-agent
package main

import (
	"context"
	"fmt"
	"log"
	"os"
	"os/signal"
	"syscall"

	"github.com/wavetermdev/waveterm/pkg/agent"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/allowlist"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/applescript"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/editor"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/farm"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/fetchmcp"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/fsmcp"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/githubmcp"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/mcpuidemo"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/playwright"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/system"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/terminal"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/vcs"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/web"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/widget"
	"github.com/wavetermdev/waveterm/pkg/authkey"
)

func main() {
	if os.Getenv("WAVETERM_AUTH_KEY") == "" {
		fmt.Fprintln(os.Stderr, "WAVETERM_AUTH_KEY required")
		os.Exit(2)
	}
	if err := authkey.SetAuthKeyFromEnv(); err != nil {
		log.Fatalf("auth: %v", err)
	}
	agent.InitAgent(context.Background())
	if agent.Server == nil {
		log.Fatal("agent did not start")
	}
	fmt.Printf("crowe-agent test harness ready: %s (auth via X-AuthKey)\n", agent.Server.Addr())

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	<-stop
	_ = agent.Server.Stop(context.Background())
}
