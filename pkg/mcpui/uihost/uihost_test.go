package uihost

import (
	"context"
	"strings"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/mcpui"
)

type fakeRenderer struct {
	html    string
	blockID string
}

func (f *fakeRenderer) Render(ctx context.Context, html string) (string, error) {
	f.html = html
	return f.blockID, nil
}

func TestRenderReusesBlockPerSessionTool(t *testing.T) {
	fakes := map[string]*fakeRenderer{}
	prev := newRenderer
	newRenderer = func(callingBlockID, session, tool string) renderer {
		k := key(session, tool)
		if _, ok := fakes[k]; !ok {
			fakes[k] = &fakeRenderer{blockID: "blk-" + k}
		}
		return fakes[k]
	}
	defer func() { newRenderer = prev }()

	ui := &mcpui.UIResource{URI: "ui://w/1", MimeType: "text/html", HTML: "<h1>1</h1>"}
	s1, err := Render(context.Background(), "sessA", "demo.tool", ui)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	ui2 := &mcpui.UIResource{URI: "ui://w/1", MimeType: "text/html", HTML: "<h1>2</h1>"}
	s2, _ := Render(context.Background(), "sessA", "demo.tool", ui2)
	if s1 != s2 {
		t.Fatalf("same session+tool must reuse one block summary: %q vs %q", s1, s2)
	}
	if len(fakes) != 1 {
		t.Fatalf("expected 1 renderer reused, got %d", len(fakes))
	}
	if fakes[key("sessA", "demo.tool")].html != "<h1>2</h1>" {
		t.Fatalf("block not updated with new html: %q", fakes[key("sessA", "demo.tool")].html)
	}
}

func TestRenderSummaryMentionsTool(t *testing.T) {
	prev := newRenderer
	newRenderer = func(callingBlockID, session, tool string) renderer { return &fakeRenderer{blockID: "blk-x"} }
	defer func() { newRenderer = prev }()

	ui := &mcpui.UIResource{URI: "ui://w/1", MimeType: "text/html", HTML: "<h1>hi</h1>"}
	summary, err := Render(context.Background(), "sessA", "demo.tool", ui)
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if !strings.Contains(summary, "demo.tool") {
		t.Fatalf("summary should mention the tool: %q", summary)
	}
}
