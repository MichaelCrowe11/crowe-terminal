package uihost

import (
	"context"
	"errors"
	"testing"

	"github.com/wavetermdev/waveterm/pkg/waveobj"
)

type fakeBlockOps struct {
	tabID      string
	findTabErr error

	createCalls  int
	createMeta   map[string]any
	createTarget string
	createBlock  string

	setMetaCalls int
	setMetaMeta  map[string]any
}

func (f *fakeBlockOps) findTab(ctx context.Context, blockID string) (string, error) {
	if f.findTabErr != nil {
		return "", f.findTabErr
	}
	return f.tabID, nil
}

func (f *fakeBlockOps) create(ctx context.Context, tabID, targetBlockID string, meta map[string]any) (string, error) {
	f.createCalls++
	f.createMeta = meta
	f.createTarget = targetBlockID
	return f.createBlock, nil
}

func (f *fakeBlockOps) setMeta(ctx context.Context, blockID string, meta map[string]any) error {
	f.setMetaCalls++
	f.setMetaMeta = meta
	return nil
}

func TestBlockRendererFirstRenderCreates(t *testing.T) {
	ops := &fakeBlockOps{tabID: "tab-1", createBlock: "blk-created"}
	r := makeBlockRenderer("caller-blk", "sessA", "demo.tool")
	r.ops = ops

	blockID, err := r.Render(context.Background(), "<h1>hi</h1>")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if blockID != "blk-created" {
		t.Fatalf("expected created block id, got %q", blockID)
	}
	if ops.createCalls != 1 {
		t.Fatalf("expected exactly 1 create call, got %d", ops.createCalls)
	}
	if ops.setMetaCalls != 0 {
		t.Fatalf("expected no setMeta on first render, got %d", ops.setMetaCalls)
	}
	if ops.createTarget != "caller-blk" {
		t.Fatalf("create should target the calling block, got %q", ops.createTarget)
	}
	if v, _ := ops.createMeta[waveobj.MetaKey_View].(string); v != View_McpUi {
		t.Fatalf("create meta view should be %q, got %q", View_McpUi, v)
	}
	if v, _ := ops.createMeta[MetaKey_McpUiHTML].(string); v != "<h1>hi</h1>" {
		t.Fatalf("create meta html mismatch: %q", v)
	}
	if v, _ := ops.createMeta[MetaKey_McpUiSession].(string); v != "sessA" {
		t.Fatalf("create meta session mismatch: %q", v)
	}
	if v, _ := ops.createMeta[MetaKey_McpUiTool].(string); v != "demo.tool" {
		t.Fatalf("create meta tool mismatch: %q", v)
	}
}

func TestBlockRendererSecondRenderUpdatesMeta(t *testing.T) {
	ops := &fakeBlockOps{tabID: "tab-1", createBlock: "blk-created"}
	r := makeBlockRenderer("caller-blk", "sessA", "demo.tool")
	r.ops = ops

	if _, err := r.Render(context.Background(), "<h1>1</h1>"); err != nil {
		t.Fatalf("first render: %v", err)
	}
	blockID, err := r.Render(context.Background(), "<h1>2</h1>")
	if err != nil {
		t.Fatalf("second render: %v", err)
	}
	if blockID != "blk-created" {
		t.Fatalf("second render should reuse block id, got %q", blockID)
	}
	if ops.createCalls != 1 {
		t.Fatalf("create must not run again, got %d calls", ops.createCalls)
	}
	if ops.setMetaCalls != 1 {
		t.Fatalf("expected exactly 1 setMeta call, got %d", ops.setMetaCalls)
	}
	if v, _ := ops.setMetaMeta[MetaKey_McpUiHTML].(string); v != "<h1>2</h1>" {
		t.Fatalf("setMeta html mismatch: %q", v)
	}
}

func TestBlockRendererFindTabErrorAborts(t *testing.T) {
	ops := &fakeBlockOps{findTabErr: errors.New("no tab")}
	r := makeBlockRenderer("caller-blk", "sessA", "demo.tool")
	r.ops = ops

	_, err := r.Render(context.Background(), "<h1>hi</h1>")
	if err == nil {
		t.Fatalf("expected findTab error to propagate")
	}
	if ops.createCalls != 0 {
		t.Fatalf("create must not run when findTab fails, got %d", ops.createCalls)
	}
}
