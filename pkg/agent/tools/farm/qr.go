// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	qrcode "github.com/skip2/go-qrcode"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.qr_label",
		Description: "Generate a printable PNG QR code for a batch label. The QR encodes a deep link " +
			"(crowe-farm://batch/<id>) plus a human-readable line. Returns the PNG path so the operator " +
			"can print and stick to the jar/bag/bucket. Defaults to ~/Documents/crowe-farm-labels/.",
		Schema:   json.RawMessage(SchemaQRLabel),
		Mutating: false,
		Handler:  handleQRLabel,
	})
}

const SchemaQRLabel = `{
  "type": "object",
  "properties": {
    "batch_id": {"type":"integer","minimum":1},
    "size":     {"type":"integer","minimum":128,"maximum":2048,"default":512,"description":"Pixel size of the square PNG."},
    "out_path": {"type":"string","description":"Override the destination PNG path."}
  },
  "required":["batch_id"],
  "additionalProperties":false
}`

type qrLabelArgs struct {
	BatchID int64  `json:"batch_id"`
	Size    int    `json:"size"`
	OutPath string `json:"out_path"`
}

func handleQRLabel(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args qrLabelArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 {
		return errResult(fmt.Errorf("batch_id required")), nil
	}
	if args.Size <= 0 {
		args.Size = 512
	}

	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	// Pull a minimal record to embed in the label payload.
	var (
		kind, strain, started string
		w                     sql.NullFloat64
	)
	err = conn.QueryRowContext(ctx, `
		SELECT kind, COALESCE(strain,''), started_at, weight_kg
		FROM batches WHERE id = ?`, args.BatchID).Scan(&kind, &strain, &started, &w)
	if err != nil {
		if err == sql.ErrNoRows {
			return errResult(fmt.Errorf("batch %d not found", args.BatchID)), nil
		}
		return errResult(err), nil
	}

	deepLink := fmt.Sprintf("crowe-farm://batch/%d", args.BatchID)
	// Single text payload - most QR scanners auto-detect URLs and offer to open.
	payload := deepLink

	out := args.OutPath
	if out == "" {
		home, _ := os.UserHomeDir()
		stamp := time.Now().UTC().Format("20060102")
		dir := filepath.Join(home, "Documents", "crowe-farm-labels-"+stamp)
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return errResult(err), nil
		}
		out = filepath.Join(dir, fmt.Sprintf("batch%d.png", args.BatchID))
	} else {
		if err := os.MkdirAll(filepath.Dir(out), 0o755); err != nil {
			return errResult(err), nil
		}
	}

	if err := qrcode.WriteFile(payload, qrcode.Medium, args.Size, out); err != nil {
		return errResult(fmt.Errorf("write qr: %w", err)), nil
	}
	stat, _ := os.Stat(out)
	body, _ := json.Marshal(map[string]any{
		"batch_id":  args.BatchID,
		"strain":    strain,
		"kind":      kind,
		"started":   started,
		"deep_link": deepLink,
		"png_path":  out,
		"png_bytes": stat.Size(),
		"size_px":   args.Size,
	})
	return registry.Result{Content: body}, nil
}
