package mcpui

import "testing"

func TestMapActionTool(t *testing.T) {
	a, err := MapAction([]byte(`{"type":"tool","payload":{"toolName":"fs.read","params":{"path":"/x"}}}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Kind != ActionTool || a.ToolName != "fs.read" {
		t.Fatalf("bad action: %+v", a)
	}
	if string(a.Params) != `{"path":"/x"}` {
		t.Fatalf("bad params: %s", a.Params)
	}
}

func TestMapActionPrompt(t *testing.T) {
	a, err := MapAction([]byte(`{"type":"prompt","payload":{"prompt":"hello"}}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Kind != ActionPrompt || a.Text != "hello" {
		t.Fatalf("bad action: %+v", a)
	}
}

func TestMapActionLink(t *testing.T) {
	a, err := MapAction([]byte(`{"type":"link","payload":{"url":"https://x.com"}}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Kind != ActionLink || a.URL != "https://x.com" {
		t.Fatalf("bad action: %+v", a)
	}
}

func TestMapActionNotify(t *testing.T) {
	a, err := MapAction([]byte(`{"type":"notify","payload":{"message":"done"}}`))
	if err != nil {
		t.Fatalf("err: %v", err)
	}
	if a.Kind != ActionNotify || a.Text != "done" {
		t.Fatalf("bad action: %+v", a)
	}
}

func TestMapActionUnknownTypeErrors(t *testing.T) {
	if _, err := MapAction([]byte(`{"type":"explode"}`)); err == nil {
		t.Fatal("unknown type must error")
	}
}

func TestMapActionMalformedErrors(t *testing.T) {
	if _, err := MapAction([]byte(`not json`)); err == nil {
		t.Fatal("malformed json must error")
	}
}
