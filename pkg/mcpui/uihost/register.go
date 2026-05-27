// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package uihost

import "github.com/wavetermdev/waveterm/pkg/agent/tools/mcpproxy"

func init() { mcpproxy.SetRenderer(Render) }
