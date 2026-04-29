// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

// ----- shared types -----

type Batch struct {
	ID         int64    `json:"id"`
	Kind       string   `json:"kind"`
	Strain     string   `json:"strain,omitempty"`
	Substrate  string   `json:"substrate,omitempty"`
	WeightKg   *float64 `json:"weight_kg,omitempty"`
	StartedAt  string   `json:"started_at"`
	Technician string   `json:"technician,omitempty"`
	ParentID   *int64   `json:"parent_id,omitempty"`
	State      string   `json:"state"`
	Notes      string   `json:"notes,omitempty"`
}

type Event struct {
	ID        int64           `json:"id"`
	BatchID   int64           `json:"batch_id"`
	EventType string          `json:"event_type"`
	TS        string          `json:"ts"`
	Notes     string          `json:"notes,omitempty"`
	Payload   json.RawMessage `json:"payload,omitempty"`
}

type Harvest struct {
	ID       int64   `json:"id"`
	BatchID  int64   `json:"batch_id"`
	TS       string  `json:"ts"`
	WeightKg float64 `json:"weight_kg"`
	Quality  string  `json:"quality,omitempty"`
	FlushNum *int    `json:"flush_num,omitempty"`
	Notes    string  `json:"notes,omitempty"`
}

// ----- registration -----

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.batch_start",
		Description: "Start a new cultivation batch (grain jar, fruiting bag, agar plate, etc). " +
			"Returns the new batch_id. Pass parent_id to record lineage from a previous batch.",
		Schema:   json.RawMessage(SchemaBatchStart),
		Mutating: false, // logging is not destructive — gating these would slow the user down
		Handler:  handleBatchStart,
	})
	registry.Register(&registry.Tool{
		Name: "farm.event",
		Description: "Record an event against a batch — inoculate, transfer, fruiting_init, " +
			"contam, fae, water, cull, note. payload is free-form JSON for things like FAE schedule, " +
			"contamination type, room conditions.",
		Schema:   json.RawMessage(SchemaEvent),
		Mutating: false,
		Handler:  handleEvent,
	})
	registry.Register(&registry.Tool{
		Name:        "farm.harvest",
		Description: "Record a harvest pulled from a fruiting batch. weight_kg required, quality + flush_num recommended.",
		Schema:      json.RawMessage(SchemaHarvest),
		Mutating:    false,
		Handler:     handleHarvest,
	})
	registry.Register(&registry.Tool{
		Name:        "farm.list_batches",
		Description: "List batches with optional filters (state, strain, kind, since). Returns most recent first, capped at limit.",
		Schema:      json.RawMessage(SchemaListBatches),
		Mutating:    false,
		Handler:     handleListBatches,
	})
	registry.Register(&registry.Tool{
		Name:        "farm.batch_history",
		Description: "Full lineage of a batch: the batch row, all events ordered by ts, all harvests ordered by ts. Pass batch_id.",
		Schema:      json.RawMessage(SchemaBatchHistory),
		Mutating:    false,
		Handler:     handleBatchHistory,
	})
	registry.Register(&registry.Tool{
		Name: "farm.yield_summary",
		Description: "Aggregate yield statistics. Optional filters: strain, since (ISO date). " +
			"Returns total weight, batch count, avg weight per batch, contamination rate.",
		Schema:   json.RawMessage(SchemaYieldSummary),
		Mutating: false,
		Handler:  handleYieldSummary,
	})
	registry.Register(&registry.Tool{
		Name: "farm.update_state",
		Description: "Mark a batch as culled or finished (terminal states). Use for contamination cull or " +
			"end-of-cycle bookkeeping. State 'active' is the default after batch_start.",
		Schema:   json.RawMessage(SchemaUpdateState),
		Mutating: true, // mutates lifecycle state
		Handler:  handleUpdateState,
	})
}

// ----- schemas -----

const SchemaBatchStart = `{
  "type": "object",
  "properties": {
    "kind":       {"type":"string","description":"grain | sawdust | bag | bulk | agar | clone | other","minLength":1},
    "strain":     {"type":"string","description":"Strain or species (e.g. 'Lions Mane', 'Blue Oyster', 'Pleurotus djamor')"},
    "substrate":  {"type":"string","description":"Recipe or source — 'sterilized rye 4lb bags' / 'master mix 5L'"},
    "weight_kg":  {"type":"number","minimum":0,"description":"Wet weight in kg if applicable"},
    "technician": {"type":"string","description":"Who did the work"},
    "parent_id":  {"type":"integer","description":"Batch this one was inoculated from / transferred from"},
    "notes":      {"type":"string"},
    "started_at": {"type":"string","description":"ISO8601 timestamp; defaults to now"}
  },
  "required":["kind"],
  "additionalProperties":false
}`

const SchemaEvent = `{
  "type": "object",
  "properties": {
    "batch_id":   {"type":"integer","minimum":1},
    "event_type": {"type":"string","enum":["inoculate","transfer","fruiting_init","contam","fae","water","cull","note","photo","sensor"]},
    "notes":      {"type":"string"},
    "payload":    {"type":"object","description":"Free-form structured payload (FAE schedule, sensor reading, contam type)"},
    "ts":         {"type":"string","description":"ISO8601 timestamp; defaults to now"}
  },
  "required":["batch_id","event_type"],
  "additionalProperties":false
}`

const SchemaHarvest = `{
  "type": "object",
  "properties": {
    "batch_id":  {"type":"integer","minimum":1},
    "weight_kg": {"type":"number","exclusiveMinimum":0},
    "quality":   {"type":"string","enum":["A","B","C","cull"]},
    "flush_num": {"type":"integer","minimum":1,"maximum":10},
    "notes":     {"type":"string"},
    "ts":        {"type":"string","description":"ISO8601; defaults to now"}
  },
  "required":["batch_id","weight_kg"],
  "additionalProperties":false
}`

const SchemaListBatches = `{
  "type": "object",
  "properties": {
    "state":  {"type":"string","enum":["active","culled","finished",""]},
    "strain": {"type":"string"},
    "kind":   {"type":"string"},
    "since":  {"type":"string","description":"ISO8601 date — only batches started on or after this date"},
    "limit":  {"type":"integer","minimum":1,"maximum":500,"default":50}
  },
  "additionalProperties":false
}`

const SchemaBatchHistory = `{
  "type": "object",
  "properties": {
    "batch_id": {"type":"integer","minimum":1}
  },
  "required":["batch_id"],
  "additionalProperties":false
}`

const SchemaYieldSummary = `{
  "type": "object",
  "properties": {
    "strain": {"type":"string"},
    "since":  {"type":"string","description":"ISO8601 date — only count batches started on or after"}
  },
  "additionalProperties":false
}`

const SchemaUpdateState = `{
  "type": "object",
  "properties": {
    "batch_id": {"type":"integer","minimum":1},
    "state":    {"type":"string","enum":["active","culled","finished"]},
    "notes":    {"type":"string"}
  },
  "required":["batch_id","state"],
  "additionalProperties":false
}`

// ----- helpers -----

func nowOr(s string) string {
	if strings.TrimSpace(s) != "" {
		return s
	}
	return time.Now().UTC().Format(time.RFC3339)
}

func errResult(err error) registry.Result {
	return registry.Result{IsError: true, ErrorText: err.Error()}
}

// ----- handlers -----

type batchStartArgs struct {
	Kind       string   `json:"kind"`
	Strain     string   `json:"strain"`
	Substrate  string   `json:"substrate"`
	WeightKg   *float64 `json:"weight_kg"`
	Technician string   `json:"technician"`
	ParentID   *int64   `json:"parent_id"`
	Notes      string   `json:"notes"`
	StartedAt  string   `json:"started_at"`
}

func handleBatchStart(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args batchStartArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if strings.TrimSpace(args.Kind) == "" {
		return errResult(fmt.Errorf("kind required")), nil
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	res, err := conn.ExecContext(ctx, `
		INSERT INTO batches (kind, strain, substrate, weight_kg, started_at, technician, parent_id, state, notes)
		VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?)
	`, args.Kind, args.Strain, args.Substrate, args.WeightKg, nowOr(args.StartedAt), args.Technician, args.ParentID, args.Notes)
	if err != nil {
		return errResult(err), nil
	}
	id, _ := res.LastInsertId()
	body, _ := json.Marshal(map[string]any{
		"batch_id": id,
		"kind":     args.Kind,
		"strain":   args.Strain,
		"state":    "active",
	})
	return registry.Result{Content: body}, nil
}

type eventArgs struct {
	BatchID   int64           `json:"batch_id"`
	EventType string          `json:"event_type"`
	Notes     string          `json:"notes"`
	Payload   json.RawMessage `json:"payload"`
	TS        string          `json:"ts"`
}

func handleEvent(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args eventArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 || args.EventType == "" {
		return errResult(fmt.Errorf("batch_id and event_type required")), nil
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	var payload sql.NullString
	if len(args.Payload) > 0 && string(args.Payload) != "null" {
		payload = sql.NullString{String: string(args.Payload), Valid: true}
	}
	res, err := conn.ExecContext(ctx, `
		INSERT INTO events (batch_id, event_type, ts, notes, payload)
		VALUES (?, ?, ?, ?, ?)
	`, args.BatchID, args.EventType, nowOr(args.TS), args.Notes, payload)
	if err != nil {
		return errResult(err), nil
	}
	id, _ := res.LastInsertId()
	body, _ := json.Marshal(map[string]any{
		"event_id":   id,
		"batch_id":   args.BatchID,
		"event_type": args.EventType,
	})
	return registry.Result{Content: body}, nil
}

type harvestArgs struct {
	BatchID  int64   `json:"batch_id"`
	WeightKg float64 `json:"weight_kg"`
	Quality  string  `json:"quality"`
	FlushNum *int    `json:"flush_num"`
	Notes    string  `json:"notes"`
	TS       string  `json:"ts"`
}

func handleHarvest(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args harvestArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 || args.WeightKg <= 0 {
		return errResult(fmt.Errorf("batch_id and positive weight_kg required")), nil
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	res, err := conn.ExecContext(ctx, `
		INSERT INTO harvests (batch_id, ts, weight_kg, quality, flush_num, notes)
		VALUES (?, ?, ?, ?, ?, ?)
	`, args.BatchID, nowOr(args.TS), args.WeightKg, args.Quality, args.FlushNum, args.Notes)
	if err != nil {
		return errResult(err), nil
	}
	id, _ := res.LastInsertId()
	body, _ := json.Marshal(map[string]any{
		"harvest_id": id,
		"batch_id":   args.BatchID,
		"weight_kg":  args.WeightKg,
	})
	return registry.Result{Content: body}, nil
}

type listBatchesArgs struct {
	State  string `json:"state"`
	Strain string `json:"strain"`
	Kind   string `json:"kind"`
	Since  string `json:"since"`
	Limit  int    `json:"limit"`
}

func handleListBatches(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args listBatchesArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &args)
	}
	if args.Limit <= 0 || args.Limit > 500 {
		args.Limit = 50
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	q := `SELECT id, kind, COALESCE(strain,''), COALESCE(substrate,''), weight_kg,
	             started_at, COALESCE(technician,''), parent_id, state, COALESCE(notes,'')
	      FROM batches WHERE 1=1`
	var argsList []any
	if args.State != "" {
		q += " AND state = ?"
		argsList = append(argsList, args.State)
	}
	if args.Strain != "" {
		q += " AND strain = ?"
		argsList = append(argsList, args.Strain)
	}
	if args.Kind != "" {
		q += " AND kind = ?"
		argsList = append(argsList, args.Kind)
	}
	if args.Since != "" {
		q += " AND started_at >= ?"
		argsList = append(argsList, args.Since)
	}
	q += " ORDER BY started_at DESC LIMIT ?"
	argsList = append(argsList, args.Limit)

	rows, err := conn.QueryContext(ctx, q, argsList...)
	if err != nil {
		return errResult(err), nil
	}
	defer rows.Close()
	var out []Batch
	for rows.Next() {
		var b Batch
		var w sql.NullFloat64
		var pid sql.NullInt64
		if err := rows.Scan(&b.ID, &b.Kind, &b.Strain, &b.Substrate, &w, &b.StartedAt,
			&b.Technician, &pid, &b.State, &b.Notes); err != nil {
			return errResult(err), nil
		}
		if w.Valid {
			v := w.Float64
			b.WeightKg = &v
		}
		if pid.Valid {
			v := pid.Int64
			b.ParentID = &v
		}
		out = append(out, b)
	}
	body, _ := json.Marshal(map[string]any{"batches": out, "count": len(out)})
	return registry.Result{Content: body}, nil
}

type batchHistoryArgs struct {
	BatchID int64 `json:"batch_id"`
}

func handleBatchHistory(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args batchHistoryArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 {
		return errResult(fmt.Errorf("batch_id required")), nil
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	var b Batch
	var w sql.NullFloat64
	var pid sql.NullInt64
	row := conn.QueryRowContext(ctx, `
		SELECT id, kind, COALESCE(strain,''), COALESCE(substrate,''), weight_kg,
		       started_at, COALESCE(technician,''), parent_id, state, COALESCE(notes,'')
		FROM batches WHERE id = ?
	`, args.BatchID)
	if err := row.Scan(&b.ID, &b.Kind, &b.Strain, &b.Substrate, &w, &b.StartedAt,
		&b.Technician, &pid, &b.State, &b.Notes); err != nil {
		if err == sql.ErrNoRows {
			return errResult(fmt.Errorf("batch %d not found", args.BatchID)), nil
		}
		return errResult(err), nil
	}
	if w.Valid {
		v := w.Float64
		b.WeightKg = &v
	}
	if pid.Valid {
		v := pid.Int64
		b.ParentID = &v
	}

	events, err := loadEvents(ctx, conn, args.BatchID)
	if err != nil {
		return errResult(err), nil
	}
	harvests, err := loadHarvests(ctx, conn, args.BatchID)
	if err != nil {
		return errResult(err), nil
	}
	body, _ := json.Marshal(map[string]any{
		"batch":    b,
		"events":   events,
		"harvests": harvests,
	})
	return registry.Result{Content: body}, nil
}

func loadEvents(ctx context.Context, conn *sql.DB, batchID int64) ([]Event, error) {
	rows, err := conn.QueryContext(ctx, `
		SELECT id, batch_id, event_type, ts, COALESCE(notes,''), COALESCE(payload,'')
		FROM events WHERE batch_id = ? ORDER BY ts ASC
	`, batchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Event
	for rows.Next() {
		var e Event
		var payload string
		if err := rows.Scan(&e.ID, &e.BatchID, &e.EventType, &e.TS, &e.Notes, &payload); err != nil {
			return nil, err
		}
		if payload != "" {
			e.Payload = json.RawMessage(payload)
		}
		out = append(out, e)
	}
	return out, nil
}

func loadHarvests(ctx context.Context, conn *sql.DB, batchID int64) ([]Harvest, error) {
	rows, err := conn.QueryContext(ctx, `
		SELECT id, batch_id, ts, weight_kg, COALESCE(quality,''), flush_num, COALESCE(notes,'')
		FROM harvests WHERE batch_id = ? ORDER BY ts ASC
	`, batchID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Harvest
	for rows.Next() {
		var h Harvest
		var fnum sql.NullInt64
		if err := rows.Scan(&h.ID, &h.BatchID, &h.TS, &h.WeightKg, &h.Quality, &fnum, &h.Notes); err != nil {
			return nil, err
		}
		if fnum.Valid {
			v := int(fnum.Int64)
			h.FlushNum = &v
		}
		out = append(out, h)
	}
	return out, nil
}

type yieldSummaryArgs struct {
	Strain string `json:"strain"`
	Since  string `json:"since"`
}

func handleYieldSummary(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args yieldSummaryArgs
	if len(raw) > 0 {
		_ = json.Unmarshal(raw, &args)
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	whereClauses := []string{"1=1"}
	whereArgs := []any{}
	if args.Strain != "" {
		whereClauses = append(whereClauses, "b.strain = ?")
		whereArgs = append(whereArgs, args.Strain)
	}
	if args.Since != "" {
		whereClauses = append(whereClauses, "b.started_at >= ?")
		whereArgs = append(whereArgs, args.Since)
	}
	where := strings.Join(whereClauses, " AND ")

	var totalWeight sql.NullFloat64
	var harvestCount int
	row := conn.QueryRowContext(ctx, `
		SELECT COALESCE(SUM(h.weight_kg), 0), COUNT(h.id)
		FROM harvests h JOIN batches b ON b.id = h.batch_id
		WHERE `+where, whereArgs...)
	if err := row.Scan(&totalWeight, &harvestCount); err != nil {
		return errResult(err), nil
	}

	var batchCount, contamCount, finishedCount int
	row = conn.QueryRowContext(ctx, `
		SELECT
			COUNT(*),
			SUM(CASE WHEN state = 'culled' THEN 1 ELSE 0 END),
			SUM(CASE WHEN state = 'finished' THEN 1 ELSE 0 END)
		FROM batches b WHERE `+where, whereArgs...)
	if err := row.Scan(&batchCount, &contamCount, &finishedCount); err != nil {
		return errResult(err), nil
	}

	var avgPerBatch float64
	if batchCount > 0 {
		avgPerBatch = totalWeight.Float64 / float64(batchCount)
	}
	var contamRate float64
	if batchCount > 0 {
		contamRate = float64(contamCount) / float64(batchCount)
	}

	body, _ := json.Marshal(map[string]any{
		"strain":          args.Strain,
		"since":           args.Since,
		"batch_count":     batchCount,
		"culled_count":    contamCount,
		"finished_count":  finishedCount,
		"harvest_count":   harvestCount,
		"total_weight_kg": totalWeight.Float64,
		"avg_kg_per_batch": avgPerBatch,
		"contam_rate":     contamRate,
	})
	return registry.Result{Content: body}, nil
}

type updateStateArgs struct {
	BatchID int64  `json:"batch_id"`
	State   string `json:"state"`
	Notes   string `json:"notes"`
}

func handleUpdateState(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args updateStateArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if args.BatchID == 0 || args.State == "" {
		return errResult(fmt.Errorf("batch_id and state required")), nil
	}
	switch args.State {
	case "active", "culled", "finished":
	default:
		return errResult(fmt.Errorf("invalid state %q", args.State)), nil
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}
	res, err := conn.ExecContext(ctx, `UPDATE batches SET state = ? WHERE id = ?`, args.State, args.BatchID)
	if err != nil {
		return errResult(err), nil
	}
	n, _ := res.RowsAffected()
	if n == 0 {
		return errResult(fmt.Errorf("batch %d not found", args.BatchID)), nil
	}
	// Auto-log a state-change event so the timeline tells the story.
	autoNote := args.Notes
	if autoNote == "" {
		autoNote = "state changed to " + args.State
	}
	_, _ = conn.ExecContext(ctx, `
		INSERT INTO events (batch_id, event_type, ts, notes) VALUES (?, ?, ?, ?)
	`, args.BatchID, args.State, time.Now().UTC().Format(time.RFC3339), autoNote)

	body, _ := json.Marshal(map[string]any{
		"batch_id": args.BatchID,
		"state":    args.State,
		"updated":  true,
	})
	return registry.Result{Content: body}, nil
}
