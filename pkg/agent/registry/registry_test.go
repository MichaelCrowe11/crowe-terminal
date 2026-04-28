// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package registry

import (
	"context"
	"encoding/json"
	"testing"
)

func TestRegisterAndCall(t *testing.T) {
	r := MakeRegistry()
	r.Register(&Tool{
		Name:        "echo",
		Description: "echo input",
		Schema:      json.RawMessage(`{"type":"object"}`),
		Handler: func(_ context.Context, args json.RawMessage) (Result, error) {
			return Result{Content: args}, nil
		},
	})
	res, err := r.Call(context.Background(), CallRequest{Name: "echo", Arguments: json.RawMessage(`{"x":1}`)})
	if err != nil {
		t.Fatalf("call: %v", err)
	}
	if string(res.Content) != `{"x":1}` {
		t.Fatalf("unexpected content %q", string(res.Content))
	}
}

func TestUnknownTool(t *testing.T) {
	r := MakeRegistry()
	res, err := r.Call(context.Background(), CallRequest{Name: "missing"})
	if err == nil {
		t.Fatalf("expected error for unknown tool")
	}
	if !res.IsError {
		t.Fatalf("expected IsError=true")
	}
}

func TestCatalogSorted(t *testing.T) {
	r := MakeRegistry()
	noop := func(_ context.Context, _ json.RawMessage) (Result, error) { return Result{}, nil }
	r.Register(&Tool{Name: "z.thing", Handler: noop, Schema: json.RawMessage(`{}`)})
	r.Register(&Tool{Name: "a.thing", Handler: noop, Schema: json.RawMessage(`{}`)})
	cat := r.Catalog()
	if len(cat) != 2 || cat[0].Function.Name != "a.thing" || cat[1].Function.Name != "z.thing" {
		t.Fatalf("catalog not sorted: %+v", cat)
	}
}

func TestRegisterIgnoresInvalid(t *testing.T) {
	r := MakeRegistry()
	r.Register(nil)
	r.Register(&Tool{Name: "no-handler"})
	r.Register(&Tool{Handler: func(_ context.Context, _ json.RawMessage) (Result, error) { return Result{}, nil }})
	if len(r.List()) != 0 {
		t.Fatalf("expected empty registry, got %d", len(r.List()))
	}
}
