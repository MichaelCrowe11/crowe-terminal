// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const (
	EnvSyncURL    = "CROWE_FARM_SYNC_URL"
	EnvSyncToken  = "CROWE_FARM_SYNC_TOKEN"
	EnvClientID   = "CROWE_FARM_CLIENT_ID"
	defaultSyncURL = "https://ai.southwestmushrooms.com/api/farm/sync"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.sync_platform",
		Description: "Push the local farm log to the Crowe Logic AI Platform " +
			"(POST /api/farm/sync). Reads CROWE_FARM_SYNC_URL (defaults to " +
			"ai.southwestmushrooms.com), CROWE_FARM_SYNC_TOKEN (bearer auth), " +
			"and CROWE_FARM_CLIENT_ID (defaults to hostname). Returns counts " +
			"received by the platform.",
		Schema:   json.RawMessage(SchemaSyncPlatform),
		Mutating: true, // sends data off-machine
		Handler:  handleSyncPlatform,
	})
}

const SchemaSyncPlatform = `{
  "type": "object",
  "properties": {
    "since":     {"type":"string","description":"ISO8601 — only send batches started on/after this. Omit to send everything."},
    "url":       {"type":"string","description":"Override the destination URL (otherwise uses CROWE_FARM_SYNC_URL or default)."},
    "client_id": {"type":"string","description":"Identifier for this farm/instance. Defaults to CROWE_FARM_CLIENT_ID env or hostname."}
  },
  "additionalProperties":false
}`

type syncArgs struct {
	Since    string `json:"since"`
	URL      string `json:"url"`
	ClientID string `json:"client_id"`
}

type syncPayload struct {
	ClientID   string             `json:"client_id"`
	Source     string             `json:"source"`
	ExportedAt string             `json:"exported_at"`
	Batches    []map[string]any   `json:"batches"`
	Events     []map[string]any   `json:"events"`
	Harvests   []map[string]any   `json:"harvests"`
}

func handleSyncPlatform(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args syncArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return errResult(err), nil
		}
	}
	url := args.URL
	if url == "" {
		url = os.Getenv(EnvSyncURL)
	}
	if url == "" {
		url = defaultSyncURL
	}
	token := os.Getenv(EnvSyncToken)
	if token == "" {
		return errResult(fmt.Errorf("CROWE_FARM_SYNC_TOKEN env var required (set on both terminal and platform sides)")), nil
	}
	clientID := args.ClientID
	if clientID == "" {
		clientID = os.Getenv(EnvClientID)
	}
	if clientID == "" {
		clientID, _ = os.Hostname()
	}
	if clientID == "" {
		clientID = "anonymous"
	}

	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	payload := syncPayload{
		ClientID:   clientID,
		Source:     "crowe-terminal",
		ExportedAt: time.Now().UTC().Format(time.RFC3339),
	}

	if err := loadSyncRows(ctx, conn, &payload, args.Since); err != nil {
		return errResult(err), nil
	}

	body, err := json.Marshal(payload)
	if err != nil {
		return errResult(err), nil
	}

	req, err := http.NewRequestWithContext(ctx, "POST", url, bytes.NewReader(body))
	if err != nil {
		return errResult(err), nil
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")

	client := &http.Client{Timeout: 30 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return errResult(fmt.Errorf("sync request failed: %w", err)), nil
	}
	defer resp.Body.Close()
	respBody := make([]byte, 0, 1024)
	buf := make([]byte, 1024)
	for {
		n, rerr := resp.Body.Read(buf)
		if n > 0 {
			respBody = append(respBody, buf[:n]...)
			if len(respBody) > 16*1024 {
				break
			}
		}
		if rerr != nil {
			break
		}
	}

	if resp.StatusCode >= 400 {
		return registry.Result{
			IsError: true,
			ErrorText: fmt.Sprintf("sync failed: HTTP %d: %s",
				resp.StatusCode, string(respBody)),
		}, nil
	}

	out, _ := json.Marshal(map[string]any{
		"sent": map[string]int{
			"batches":  len(payload.Batches),
			"events":   len(payload.Events),
			"harvests": len(payload.Harvests),
		},
		"client_id":      clientID,
		"url":            url,
		"platform_reply": json.RawMessage(respBody),
	})
	return registry.Result{Content: out}, nil
}

func loadSyncRows(ctx context.Context, conn *sql.DB, p *syncPayload, since string) error {
	// batches
	q := `SELECT id, kind, COALESCE(strain,''), COALESCE(substrate,''), weight_kg,
	             started_at, COALESCE(technician,''), parent_id, state, COALESCE(notes,'')
	      FROM batches`
	var qargs []any
	if since != "" {
		q += " WHERE started_at >= ?"
		qargs = append(qargs, since)
	}
	rows, err := conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id int64
		var kind, strain, substrate, startedAt, technician, state, notes string
		var weight sql.NullFloat64
		var parent sql.NullInt64
		if err := rows.Scan(&id, &kind, &strain, &substrate, &weight, &startedAt,
			&technician, &parent, &state, &notes); err != nil {
			rows.Close()
			return err
		}
		row := map[string]any{
			"id": id, "kind": kind, "strain": strain, "substrate": substrate,
			"started_at": startedAt, "technician": technician, "state": state, "notes": notes,
		}
		if weight.Valid {
			row["weight_kg"] = weight.Float64
		}
		if parent.Valid {
			row["parent_id"] = parent.Int64
		}
		p.Batches = append(p.Batches, row)
	}
	rows.Close()

	// events
	q = `SELECT e.id, e.batch_id, e.event_type, e.ts, COALESCE(e.notes,''), COALESCE(e.payload,'')
	     FROM events e JOIN batches b ON b.id = e.batch_id`
	qargs = nil
	if since != "" {
		q += " WHERE b.started_at >= ?"
		qargs = append(qargs, since)
	}
	rows, err = conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, batchID int64
		var eventType, ts, notes, payload string
		if err := rows.Scan(&id, &batchID, &eventType, &ts, &notes, &payload); err != nil {
			rows.Close()
			return err
		}
		row := map[string]any{
			"id": id, "batch_id": batchID, "event_type": eventType, "ts": ts, "notes": notes,
		}
		if payload != "" {
			var parsed any
			if err := json.Unmarshal([]byte(payload), &parsed); err == nil {
				row["payload"] = parsed
			} else {
				row["payload_raw"] = payload
			}
		}
		p.Events = append(p.Events, row)
	}
	rows.Close()

	// harvests
	q = `SELECT h.id, h.batch_id, h.ts, h.weight_kg, COALESCE(h.quality,''), h.flush_num, COALESCE(h.notes,'')
	     FROM harvests h JOIN batches b ON b.id = h.batch_id`
	qargs = nil
	if since != "" {
		q += " WHERE b.started_at >= ?"
		qargs = append(qargs, since)
	}
	rows, err = conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var id, batchID int64
		var ts, quality, notes string
		var weight float64
		var flushNum sql.NullInt64
		if err := rows.Scan(&id, &batchID, &ts, &weight, &quality, &flushNum, &notes); err != nil {
			rows.Close()
			return err
		}
		row := map[string]any{
			"id": id, "batch_id": batchID, "ts": ts,
			"weight_kg": weight, "quality": quality, "notes": notes,
		}
		if flushNum.Valid {
			row["flush_num"] = flushNum.Int64
		}
		p.Harvests = append(p.Harvests, row)
	}
	rows.Close()
	return nil
}
