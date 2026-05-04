// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// Package widget exposes Crowe Terminal block-creation tools to the agent.
// Phase 1 ships a single tool, widget.open_in_crowecode, which materializes
// a file as a new Crowe Code block in the same tab as the calling block.
// Future entries will cover other view types (preview, web, sysinfo) on
// demand; we intentionally avoid a generic widget.create_block to keep the
// agent's surface intentional rather than a free-form layout API.
package widget

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
	"github.com/wavetermdev/waveterm/pkg/agent/scope"
	"github.com/wavetermdev/waveterm/pkg/waveobj"
	"github.com/wavetermdev/waveterm/pkg/wcore"
	"github.com/wavetermdev/waveterm/pkg/wstore"
)

const (
	ViewCroweCode        = "crowecode"
	MetaKeyCroweCodeFile = "crowecode:file"
	MetaKeyCroweCodeLang = "crowecode:language"

	MaxFileSizeOnOpen = 1 << 20
)

var sensitivePathPrefixes = []string{
	"/System",
	"/private/var/db",
	"/Library/Keychains",
	"/etc/ssh",
	"/etc/sudoers",
}

var sensitivePathSuffixes = []string{
	"/.aws/credentials",
	"/.aws/config",
	"/.netrc",
	"/.npmrc",
	"/.pypirc",
}

var sensitivePathSubstrings = []string{
	"/.ssh/id_",
	"/Keychains/",
	"/.gnupg/",
}

var sensitivePathExts = []string{
	".pem",
	".key",
	".pfx",
	".p12",
}

func init() {
	registry.Register(&registry.Tool{
		Name: "widget.open_in_crowecode",
		Description: "Open a file as a new Crowe Code block in the user's " +
			"current tab. The new block loads the file from disk on mount; " +
			"this tool does NOT read or modify file contents itself. Use " +
			"this when the user asks to view, edit, or pull up a file as a " +
			"tile in the workspace. Path must be absolute.",
		Schema:          json.RawMessage(schemaOpenInCroweCode),
		Mutating:        true,
		Handler:         handleOpenInCroweCode,
		TargetExtractor: extractPath,
	})
}

const schemaOpenInCroweCode = `{
  "type": "object",
  "properties": {
    "path":     {"type":"string","description":"Absolute file path to open."},
    "language": {"type":"string","description":"Optional language id override (e.g. 'typescript'). If omitted the editor infers from extension."}
  },
  "required":["path"],
  "additionalProperties":false
}`

type openArgs struct {
	Path     string `json:"path"`
	Language string `json:"language,omitempty"`
}

func extractPath(args json.RawMessage) string {
	var probe struct {
		Path string `json:"path"`
	}
	if err := json.Unmarshal(args, &probe); err != nil {
		return ""
	}
	return probe.Path
}

func handleOpenInCroweCode(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args openArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	abs, err := normalizePath(args.Path)
	if err != nil {
		return errResult(err), nil
	}
	info, err := os.Stat(abs)
	if err != nil {
		return errResult(fmt.Errorf("cannot stat %s: %w", abs, err)), nil
	}
	if info.IsDir() {
		return errResult(fmt.Errorf("path is a directory: %s", abs)), nil
	}
	if info.Size() > MaxFileSizeOnOpen {
		return errResult(fmt.Errorf("file too large for crowecode block: %d bytes (cap %d)", info.Size(), MaxFileSizeOnOpen)), nil
	}
	blockID, ok := scope.BlockIDFromContext(ctx)
	if !ok {
		return errResult(fmt.Errorf("no calling block in context; widget tools require an embedded agent")), nil
	}
	tabID, err := wstore.DBFindTabForBlockId(ctx, blockID)
	if err != nil {
		return errResult(fmt.Errorf("cannot resolve tab for block %s: %w", blockID, err)), nil
	}
	meta := waveobj.MetaMapType{
		waveobj.MetaKey_View: ViewCroweCode,
		MetaKeyCroweCodeFile: abs,
	}
	if args.Language != "" {
		meta[MetaKeyCroweCodeLang] = args.Language
	}
	blockDef := &waveobj.BlockDef{Meta: meta}
	block, err := wcore.CreateBlock(ctx, tabID, blockDef, &waveobj.RuntimeOpts{})
	if err != nil {
		return errResult(fmt.Errorf("create block failed: %w", err)), nil
	}
	body, _ := json.Marshal(map[string]any{
		"blockid":  block.OID,
		"tabid":    tabID,
		"path":     abs,
		"language": args.Language,
		"size":     info.Size(),
	})
	return registry.Result{Content: body}, nil
}

func normalizePath(p string) (string, error) {
	p = strings.TrimSpace(p)
	if p == "" {
		return "", fmt.Errorf("path required")
	}
	if !filepath.IsAbs(p) {
		return "", fmt.Errorf("path must be absolute: %s", p)
	}
	cleaned := filepath.Clean(p)
	abs, err := filepath.EvalSymlinks(cleaned)
	if err != nil {
		abs = cleaned
	}
	if blocked, why := isSensitive(cleaned); blocked {
		return "", fmt.Errorf("path is in a protected location (%s): %s", why, cleaned)
	}
	if abs != cleaned {
		if blocked, why := isSensitive(abs); blocked {
			return "", fmt.Errorf("path resolves to a protected location (%s): %s -> %s", why, cleaned, abs)
		}
	}
	return abs, nil
}

func isSensitive(abs string) (bool, string) {
	for _, prefix := range sensitivePathPrefixes {
		if strings.HasPrefix(abs, prefix+"/") || abs == prefix {
			return true, "system path"
		}
	}
	for _, suffix := range sensitivePathSuffixes {
		if strings.HasSuffix(abs, suffix) {
			return true, "credential file"
		}
	}
	for _, sub := range sensitivePathSubstrings {
		if strings.Contains(abs, sub) {
			return true, "secret store"
		}
	}
	ext := strings.ToLower(filepath.Ext(abs))
	for _, e := range sensitivePathExts {
		if ext == e {
			return true, "key material"
		}
	}
	base := filepath.Base(abs)
	if base == ".env" || strings.HasPrefix(base, ".env.") {
		return true, "env file"
	}
	return false, ""
}

func errResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}
