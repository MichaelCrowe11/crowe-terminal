// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package agent

import "github.com/wavetermdev/waveterm/pkg/agent/registry"

func registryList() []*registry.Tool {
	return registry.Default().List()
}
