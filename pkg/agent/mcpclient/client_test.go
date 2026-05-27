// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package mcpclient

import (
	"encoding/json"
	"testing"
)

func TestContentItemUnmarshalEmbeddedResource(t *testing.T) {
	raw := `{"content":[{"type":"resource","resource":{"uri":"ui://widget/1","mimeType":"text/html","text":"<h1>hi</h1>"}}]}`
	var cr CallResult
	if err := json.Unmarshal([]byte(raw), &cr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if len(cr.Content) != 1 {
		t.Fatalf("want 1 content item, got %d", len(cr.Content))
	}
	res := cr.Content[0].Resource
	if res == nil {
		t.Fatal("resource is nil")
	}
	if res.URI != "ui://widget/1" || res.MimeType != "text/html" || res.Text != "<h1>hi</h1>" {
		t.Fatalf("bad resource: %+v", res)
	}
}

func TestContentItemBackwardCompatTextOnly(t *testing.T) {
	raw := `{"content":[{"type":"text","text":"plain"}]}`
	var cr CallResult
	if err := json.Unmarshal([]byte(raw), &cr); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if cr.Content[0].Text != "plain" || cr.Content[0].Resource != nil {
		t.Fatalf("backward-compat broken: %+v", cr.Content[0])
	}
}
