// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

package aiusechat

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

func TestAccountHTTPFrontendGuardPrecedesCredentialAccess(t *testing.T) {
	file, err := parser.ParseFile(token.NewFileSet(), "usechat.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	var handler *ast.FuncDecl
	for _, decl := range file.Decls {
		if fn, ok := decl.(*ast.FuncDecl); ok && fn.Name.Name == "WaveAIPostMessageHandler" {
			handler = fn
		}
	}
	if handler == nil {
		t.Fatal("missing HTTP message handler")
	}
	var accountBlock *ast.BlockStmt
	ast.Inspect(handler, func(node ast.Node) bool {
		stmt, ok := node.(*ast.IfStmt)
		if !ok {
			return true
		}
		condition, ok := stmt.Cond.(*ast.BinaryExpr)
		if !ok || condition.Op != token.EQL {
			return true
		}
		mode, ok := condition.Y.(*ast.SelectorExpr)
		if ok && mode.Sel.Name == "APIType_CroweGateway" {
			accountBlock = stmt.Body
		}
		return true
	})
	if accountBlock == nil || len(accountBlock.List) < 2 {
		t.Fatal("missing account-only credential branch")
	}
	guard, ok := accountBlock.List[0].(*ast.IfStmt)
	if !ok {
		t.Fatal("frontend guard must be first in the account branch")
	}
	negated, ok := guard.Cond.(*ast.UnaryExpr)
	if !ok || negated.Op != token.NOT {
		t.Fatal("frontend guard does not reject unverified requests")
	}
	call, ok := negated.X.(*ast.CallExpr)
	if !ok || len(call.Args) != 1 {
		t.Fatal("frontend guard does not inspect the request")
	}
	selector, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || selector.Sel.Name != "IsLocalFrontendRequest" {
		t.Fatal("frontend guard does not verify the capability")
	}
	pkg, ok := selector.X.(*ast.Ident)
	if !ok || pkg.Name != "authkey" {
		t.Fatal("frontend guard uses an unexpected verifier")
	}
	request, ok := call.Args[0].(*ast.Ident)
	if !ok || request.Name != "r" {
		t.Fatal("frontend guard does not inspect the actual incoming request")
	}
	if len(guard.Body.List) == 0 {
		t.Fatal("frontend guard has no rejection body")
	}
	if _, ok := guard.Body.List[len(guard.Body.List)-1].(*ast.ReturnStmt); !ok {
		t.Fatal("unverified request can fall through to credential access")
	}
	foundCredentialAccess := false
	ast.Inspect(handler, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		selector, ok := call.Fun.(*ast.SelectorExpr)
		if !ok || (selector.Sel.Name != "SessionContext" && selector.Sel.Name != "Token") {
			return true
		}
		foundCredentialAccess = true
		if call.Pos() < guard.End() || call.End() > accountBlock.End() {
			t.Error("account credential access is not dominated by the frontend guard")
		}
		return true
	})
	if !foundCredentialAccess {
		t.Fatal("missing account credential access; revisit this boundary regression")
	}
}
