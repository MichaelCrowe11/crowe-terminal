// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package fetchmcp proxies @modelcontextprotocol/server-fetch — a
// straightforward HTTP fetch tool the model can use for "look up X
// without opening a browser block." All tools non-mutating (it's reads).
//
// Activate: CROWE_AGENT_FETCH=1
package fetchmcp

import "github.com/wavetermdev/waveterm/pkg/agent/tools/mcpproxy"

const enableEnv = "CROWE_AGENT_FETCH"

func init() {
	mcpproxy.Activate(&mcpproxy.Mount{
		EnableEnv: enableEnv,
		Namespace: "fetch.",
		Command:   "npx",
		Args:      []string{"-y", "@modelcontextprotocol/server-fetch"},
		LogLabel:  "agent-fetch",
		// fetch tools are read-only; default IsMutating=nil leaves them safe.
	})
}
