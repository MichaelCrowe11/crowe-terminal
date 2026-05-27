// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpui

import (
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
)

// Detect returns the first renderable MCP-UI resource in content, if any.
// A resource is renderable when its URI starts with "ui://" and its
// mimeType is supported (phase 1: text/html only).
func Detect(content []mcpclient.ContentItem) (*UIResource, bool) {
	for _, item := range content {
		r := item.Resource
		if r == nil || !strings.HasPrefix(r.URI, UISchemePrefix) {
			continue
		}
		if r.MimeType == MimeHTML {
			return &UIResource{URI: r.URI, MimeType: r.MimeType, HTML: r.Text}, true
		}
	}
	return nil, false
}
