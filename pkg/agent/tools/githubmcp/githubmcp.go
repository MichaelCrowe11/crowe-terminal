// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package githubmcp proxies @modelcontextprotocol/server-github — issues,
// PRs, file ops on remote repos. Mutating tools are flagged so the
// approval flow gates them.
//
// Activate: CROWE_AGENT_GITHUB=1 plus GITHUB_PERSONAL_ACCESS_TOKEN.
// (The token is consumed by the upstream MCP server; we just pass env
// through.)
package githubmcp

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/tools/mcpproxy"
)

const enableEnv = "CROWE_AGENT_GITHUB"

func init() {
	mcpproxy.Activate(&mcpproxy.Mount{
		EnableEnv:  enableEnv,
		Namespace:  "github.",
		Command:    "npx",
		Args:       []string{"-y", "@modelcontextprotocol/server-github"},
		LogLabel:   "agent-github",
		IsMutating: isMutatingGitHubTool,
	})
}

// isMutatingGitHubTool flags tools that change remote state. The upstream
// server prefixes mutations with create_/update_/delete_/merge_/push_/fork_
// so we can pattern-match without enumerating every tool name.
func isMutatingGitHubTool(name string) bool {
	prefixes := []string{
		"create_", "update_", "delete_", "merge_", "push_",
		"fork_", "add_", "remove_", "request_",
	}
	for _, p := range prefixes {
		if strings.HasPrefix(name, p) {
			return true
		}
	}
	return false
}
