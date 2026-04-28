// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package agent wires the Crowe Terminal agentic orchestrator: a tool
// registry, a transport that exposes those tools to the Foundry bridge,
// and an event hub for tool-call lifecycle. This package only sets up
// the plumbing — individual tools register themselves from their own
// packages via init() so they can be enabled/disabled independently.
package agent

import (
	"context"
	"log"
	"os"
	"strconv"

	"github.com/wavetermdev/waveterm/pkg/agent/events"
	"github.com/wavetermdev/waveterm/pkg/agent/tools/terminal"
	"github.com/wavetermdev/waveterm/pkg/agent/transport/agenthttp"
)

const (
	EnvAgentDisabled = "CROWE_AGENT_DISABLED"
	EnvAgentPort     = "CROWE_AGENT_PORT"
	EnvAgentHost     = "CROWE_AGENT_HOST"
)

var (
	Hub    = events.MakeHub()
	Server *agenthttp.Server
)

func InitAgent(ctx context.Context) {
	if os.Getenv(EnvAgentDisabled) == "1" {
		log.Printf("[agent] disabled via %s=1\n", EnvAgentDisabled)
		return
	}
	host := os.Getenv(EnvAgentHost)
	if host == "" {
		host = agenthttp.DefaultHost
	}
	port := agenthttp.DefaultPort
	if v := os.Getenv(EnvAgentPort); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n < 65536 {
			port = n
		}
	}
	Server = agenthttp.MakeServer(host, port, Hub)
	if err := Server.Start(ctx); err != nil {
		log.Printf("[agent] failed to start transport: %v\n", err)
		Server = nil
		return
	}
	terminal.SetEventHub(Hub)
	log.Printf("[agent] ready on http://%s/ (tools=%d)\n", Server.Addr(), toolCount())
}

func toolCount() int {
	// imported here to avoid a cycle in the package init order
	return len(registryList())
}
