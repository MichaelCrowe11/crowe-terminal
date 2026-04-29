// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// crowe-mcp is the standalone MCP server binary that exposes the Crowe
// Agent tool registry over stdio. Wire it into Claude Desktop, Cursor,
// or any other MCP client:
//
//   {
//     "mcpServers": {
//       "crowe-terminal": {
//         "command": "/path/to/crowe-mcp"
//       }
//     }
//   }
//
// All registered tools are available — system metrics, terminal exec,
// AppleScript, allowlist management, and Playwright (when enabled).
package main

import (
	"context"
	"log"
	"os"
	"os/signal"
	"syscall"

	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/allowlist"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/applescript"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/fetchmcp"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/fsmcp"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/githubmcp"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/playwright"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/system"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/terminal"
	_ "github.com/wavetermdev/waveterm/pkg/agent/tools/web"
	"github.com/wavetermdev/waveterm/pkg/agent/transport/agentmcp"
)

func main() {
	// Logs go to stderr — MCP framing owns stdout.
	log.SetOutput(os.Stderr)
	log.SetPrefix("[crowe-mcp] ")

	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-stop
		cancel()
	}()

	srv := agentmcp.MakeServer(os.Stdin, os.Stdout)
	log.Printf("ready: %s", agentmcp.Description())
	if err := srv.Serve(ctx); err != nil && err != context.Canceled {
		log.Printf("serve error: %v", err)
		os.Exit(1)
	}
}
