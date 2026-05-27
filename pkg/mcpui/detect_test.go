package mcpui

import (
	"testing"

	"github.com/wavetermdev/waveterm/pkg/agent/mcpclient"
)

func html(uri, mime, text string) mcpclient.ContentItem {
	return mcpclient.ContentItem{
		Type:     "resource",
		Resource: &mcpclient.EmbeddedResource{URI: uri, MimeType: mime, Text: text},
	}
}

func TestDetectFindsHTMLUIResource(t *testing.T) {
	content := []mcpclient.ContentItem{
		{Type: "text", Text: "preamble"},
		html("ui://widget/1", "text/html", "<h1>hi</h1>"),
	}
	got, ok := Detect(content)
	if !ok {
		t.Fatal("expected detection")
	}
	if got.URI != "ui://widget/1" || got.HTML != "<h1>hi</h1>" {
		t.Fatalf("bad resource: %+v", got)
	}
}

func TestDetectIgnoresNonUIResource(t *testing.T) {
	content := []mcpclient.ContentItem{html("file:///x.txt", "text/plain", "data")}
	if _, ok := Detect(content); ok {
		t.Fatal("non-ui:// resource must not be detected")
	}
}

func TestDetectIgnoresPlainText(t *testing.T) {
	content := []mcpclient.ContentItem{{Type: "text", Text: "just text"}}
	if _, ok := Detect(content); ok {
		t.Fatal("plain text must not be detected")
	}
}

func TestDetectRemoteDomUnsupportedInPhase1(t *testing.T) {
	content := []mcpclient.ContentItem{
		html("ui://widget/2", "application/vnd.mcp-ui.remote-dom", "script"),
	}
	if _, ok := Detect(content); ok {
		t.Fatal("remote-dom must be unsupported (text fallback) in phase 1")
	}
}

func TestDetectReturnsFirstUIResource(t *testing.T) {
	content := []mcpclient.ContentItem{
		html("ui://a", "text/html", "<p>A</p>"),
		html("ui://b", "text/html", "<p>B</p>"),
	}
	got, _ := Detect(content)
	if got.URI != "ui://a" {
		t.Fatalf("want first resource ui://a, got %s", got.URI)
	}
}
