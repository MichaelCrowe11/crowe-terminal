// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package fsmcp proxies @modelcontextprotocol/server-filesystem so the
// model can read/write files under user-allowlisted roots.
//
// Activate: CROWE_AGENT_FS=1 plus CROWE_AGENT_FS_ROOTS=/abs/path1,/abs/path2
// Mutating tools (write/move/delete) are flagged so Wave's approval
// flow gates them like any other mutation.
package fsmcp

import (
	"os"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/tools/mcpproxy"
)

const (
	enableEnv = "CROWE_AGENT_FS"
	rootsEnv  = "CROWE_AGENT_FS_ROOTS"
)

func init() {
	roots := strings.Split(os.Getenv(rootsEnv), ",")
	clean := roots[:0]
	for _, r := range roots {
		r = strings.TrimSpace(r)
		if r != "" {
			clean = append(clean, r)
		}
	}
	if os.Getenv(enableEnv) == "1" && len(clean) == 0 {
		// Default to a single safe root so the model has something
		// to work with even without explicit config: $HOME/Documents.
		if h, err := os.UserHomeDir(); err == nil {
			clean = []string{h + "/Documents"}
		}
	}
	args := []string{"-y", "@modelcontextprotocol/server-filesystem"}
	args = append(args, clean...)
	mcpproxy.Activate(&mcpproxy.Mount{
		EnableEnv: enableEnv,
		Namespace: "fs.",
		Command:   "npx",
		Args:      args,
		LogLabel:  "agent-fs",
		IsMutating: func(name string) bool {
			switch name {
			case "write_file", "edit_file", "create_directory",
				"move_file", "delete_file", "delete_directory":
				return true
			}
			return false
		},
	})
}
