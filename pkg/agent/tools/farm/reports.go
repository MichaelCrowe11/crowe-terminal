// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"database/sql"
	"encoding/csv"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.export_csv",
		Description: "Export the cultivation log to CSV files (batches.csv, events.csv, harvests.csv) " +
			"in the given directory. Use for compliance reporting, sharing with a consulting mycologist, " +
			"or backup. Returns the absolute paths written.",
		Schema:   json.RawMessage(SchemaExportCSV),
		Mutating: false,
		Handler:  handleExportCSV,
	})
	registry.Register(&registry.Tool{
		Name: "farm.report",
		Description: "Generate a markdown summary of cultivation activity over the last N days. " +
			"Includes new batches, harvests, contamination/cull events, yield totals, and active batch " +
			"counts. Use when the user wants a journal entry, weekly review, or shareable update.",
		Schema:   json.RawMessage(SchemaReport),
		Mutating: false,
		Handler:  handleReport,
	})
}

const SchemaExportCSV = `{
  "type": "object",
  "properties": {
    "out_dir": {"type":"string","description":"Directory path for the CSVs. Defaults to $HOME/Documents/crowe-farm-export-YYYYMMDD/"},
    "since":   {"type":"string","description":"ISO date — only export batches started on or after this. Defaults to all-time."}
  },
  "additionalProperties": false
}`

const SchemaReport = `{
  "type": "object",
  "properties": {
    "days":    {"type":"integer","minimum":1,"maximum":365,"default":7,"description":"How many days back to summarize."},
    "strain":  {"type":"string","description":"Optional strain filter."},
    "out_path":{"type":"string","description":"Optional file path to write the markdown to. If omitted, returns the report inline."}
  },
  "additionalProperties": false
}`

// ----- export_csv -----

type exportCSVArgs struct {
	OutDir string `json:"out_dir"`
	Since  string `json:"since"`
}

func handleExportCSV(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args exportCSVArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return errResult(err), nil
		}
	}
	if args.OutDir == "" {
		home, _ := os.UserHomeDir()
		stamp := time.Now().UTC().Format("20060102")
		args.OutDir = filepath.Join(home, "Documents", "crowe-farm-export-"+stamp)
	}
	if err := os.MkdirAll(args.OutDir, 0o755); err != nil {
		return errResult(fmt.Errorf("mkdir %s: %w", args.OutDir, err)), nil
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	batchesPath := filepath.Join(args.OutDir, "batches.csv")
	eventsPath := filepath.Join(args.OutDir, "events.csv")
	harvestsPath := filepath.Join(args.OutDir, "harvests.csv")

	batchCount, err := exportBatches(ctx, conn, batchesPath, args.Since)
	if err != nil {
		return errResult(fmt.Errorf("export batches: %w", err)), nil
	}
	eventCount, err := exportEvents(ctx, conn, eventsPath, args.Since)
	if err != nil {
		return errResult(fmt.Errorf("export events: %w", err)), nil
	}
	harvestCount, err := exportHarvests(ctx, conn, harvestsPath, args.Since)
	if err != nil {
		return errResult(fmt.Errorf("export harvests: %w", err)), nil
	}

	body, _ := json.Marshal(map[string]any{
		"out_dir":       args.OutDir,
		"batches_path":  batchesPath,
		"events_path":   eventsPath,
		"harvests_path": harvestsPath,
		"batch_count":   batchCount,
		"event_count":   eventCount,
		"harvest_count": harvestCount,
	})
	return registry.Result{Content: body}, nil
}

func exportBatches(ctx context.Context, conn *sql.DB, path, since string) (int, error) {
	q := `SELECT id, kind, COALESCE(strain,''), COALESCE(substrate,''), weight_kg,
	             started_at, COALESCE(technician,''), parent_id, state, COALESCE(notes,'')
	      FROM batches`
	var qargs []any
	if since != "" {
		q += " WHERE started_at >= ?"
		qargs = append(qargs, since)
	}
	q += " ORDER BY id ASC"
	rows, err := conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	defer w.Flush()

	if err := w.Write([]string{"id", "kind", "strain", "substrate", "weight_kg",
		"started_at", "technician", "parent_id", "state", "notes"}); err != nil {
		return 0, err
	}

	count := 0
	for rows.Next() {
		var id int64
		var kind, strain, substrate, startedAt, technician, state, notes string
		var weight sql.NullFloat64
		var parent sql.NullInt64
		if err := rows.Scan(&id, &kind, &strain, &substrate, &weight,
			&startedAt, &technician, &parent, &state, &notes); err != nil {
			return count, err
		}
		row := []string{
			strconv.FormatInt(id, 10),
			kind, strain, substrate,
			optFloat(weight), startedAt, technician,
			optInt(parent), state, notes,
		}
		if err := w.Write(row); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func exportEvents(ctx context.Context, conn *sql.DB, path, since string) (int, error) {
	q := `SELECT e.id, e.batch_id, e.event_type, e.ts, COALESCE(e.notes,''), COALESCE(e.payload,'')
	      FROM events e JOIN batches b ON b.id = e.batch_id`
	var qargs []any
	if since != "" {
		q += " WHERE b.started_at >= ?"
		qargs = append(qargs, since)
	}
	q += " ORDER BY e.id ASC"
	rows, err := conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	defer w.Flush()
	if err := w.Write([]string{"id", "batch_id", "event_type", "ts", "notes", "payload"}); err != nil {
		return 0, err
	}

	count := 0
	for rows.Next() {
		var id, batchID int64
		var eventType, ts, notes, payload string
		if err := rows.Scan(&id, &batchID, &eventType, &ts, &notes, &payload); err != nil {
			return count, err
		}
		if err := w.Write([]string{
			strconv.FormatInt(id, 10),
			strconv.FormatInt(batchID, 10),
			eventType, ts, notes, payload,
		}); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func exportHarvests(ctx context.Context, conn *sql.DB, path, since string) (int, error) {
	q := `SELECT h.id, h.batch_id, h.ts, h.weight_kg, COALESCE(h.quality,''), h.flush_num, COALESCE(h.notes,'')
	      FROM harvests h JOIN batches b ON b.id = h.batch_id`
	var qargs []any
	if since != "" {
		q += " WHERE b.started_at >= ?"
		qargs = append(qargs, since)
	}
	q += " ORDER BY h.id ASC"
	rows, err := conn.QueryContext(ctx, q, qargs...)
	if err != nil {
		return 0, err
	}
	defer rows.Close()

	f, err := os.Create(path)
	if err != nil {
		return 0, err
	}
	defer f.Close()
	w := csv.NewWriter(f)
	defer w.Flush()
	if err := w.Write([]string{"id", "batch_id", "ts", "weight_kg", "quality", "flush_num", "notes"}); err != nil {
		return 0, err
	}

	count := 0
	for rows.Next() {
		var id, batchID int64
		var ts, quality, notes string
		var weight float64
		var flushNum sql.NullInt64
		if err := rows.Scan(&id, &batchID, &ts, &weight, &quality, &flushNum, &notes); err != nil {
			return count, err
		}
		if err := w.Write([]string{
			strconv.FormatInt(id, 10),
			strconv.FormatInt(batchID, 10),
			ts,
			strconv.FormatFloat(weight, 'f', 3, 64),
			quality,
			optInt(flushNum),
			notes,
		}); err != nil {
			return count, err
		}
		count++
	}
	return count, rows.Err()
}

func optFloat(v sql.NullFloat64) string {
	if !v.Valid {
		return ""
	}
	return strconv.FormatFloat(v.Float64, 'f', 3, 64)
}

func optInt(v sql.NullInt64) string {
	if !v.Valid {
		return ""
	}
	return strconv.FormatInt(v.Int64, 10)
}

// ----- report -----

type reportArgs struct {
	Days    int    `json:"days"`
	Strain  string `json:"strain"`
	OutPath string `json:"out_path"`
}

type reportData struct {
	Since         string
	Until         string
	Strain        string
	NewBatches    []Batch
	Harvests      []reportHarvestRow
	Contam        []reportEventRow
	StateChanges  []reportEventRow
	ActiveCount   int
	CulledCount   int
	FinishedCount int
	TotalKg       float64
	StrainTotals  map[string]float64
}

type reportHarvestRow struct {
	Harvest
	Strain string
}

type reportEventRow struct {
	Event
	Strain string
}

func handleReport(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args reportArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return errResult(err), nil
		}
	}
	if args.Days <= 0 {
		args.Days = 7
	}
	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	rd := reportData{
		Until:        time.Now().UTC().Format(time.RFC3339),
		Since:        time.Now().UTC().Add(-time.Duration(args.Days) * 24 * time.Hour).Format(time.RFC3339),
		Strain:       args.Strain,
		StrainTotals: map[string]float64{},
	}

	if err := loadReportData(ctx, conn, &rd); err != nil {
		return errResult(err), nil
	}

	md := renderReport(&rd, args.Days)
	out := map[string]any{
		"days":          args.Days,
		"since":         rd.Since,
		"new_batches":   len(rd.NewBatches),
		"harvests":      len(rd.Harvests),
		"contam_events": len(rd.Contam),
		"total_kg":      rd.TotalKg,
		"markdown":      md,
	}
	if args.OutPath != "" {
		if err := os.MkdirAll(filepath.Dir(args.OutPath), 0o755); err == nil {
			_ = os.WriteFile(args.OutPath, []byte(md), 0o644)
			out["written_to"] = args.OutPath
		}
	}
	body, _ := json.Marshal(out)
	return registry.Result{Content: body}, nil
}

func loadReportData(ctx context.Context, conn *sql.DB, rd *reportData) error {
	strainFilter := ""
	var strainArgs []any
	if rd.Strain != "" {
		strainFilter = " AND b.strain = ?"
		strainArgs = []any{rd.Strain}
	}

	// New batches in window
	q := `SELECT id, kind, COALESCE(strain,''), COALESCE(substrate,''), weight_kg,
	             started_at, COALESCE(technician,''), parent_id, state, COALESCE(notes,'')
	      FROM batches b WHERE started_at >= ?` + strainFilter + ` ORDER BY started_at ASC`
	args := append([]any{rd.Since}, strainArgs...)
	rows, err := conn.QueryContext(ctx, q, args...)
	if err != nil {
		return err
	}
	for rows.Next() {
		var b Batch
		var w sql.NullFloat64
		var pid sql.NullInt64
		if err := rows.Scan(&b.ID, &b.Kind, &b.Strain, &b.Substrate, &w, &b.StartedAt,
			&b.Technician, &pid, &b.State, &b.Notes); err != nil {
			rows.Close()
			return err
		}
		if w.Valid {
			v := w.Float64
			b.WeightKg = &v
		}
		if pid.Valid {
			v := pid.Int64
			b.ParentID = &v
		}
		rd.NewBatches = append(rd.NewBatches, b)
	}
	rows.Close()

	// Harvests in window with strain join
	q = `SELECT h.id, h.batch_id, h.ts, h.weight_kg, COALESCE(h.quality,''), h.flush_num, COALESCE(h.notes,''),
	            COALESCE(b.strain,'')
	     FROM harvests h JOIN batches b ON b.id = h.batch_id
	     WHERE h.ts >= ?` + strainFilter + ` ORDER BY h.ts ASC`
	args = append([]any{rd.Since}, strainArgs...)
	hRows, err := conn.QueryContext(ctx, q, args...)
	if err != nil {
		return err
	}
	for hRows.Next() {
		var hr reportHarvestRow
		var fn sql.NullInt64
		if err := hRows.Scan(&hr.ID, &hr.BatchID, &hr.TS, &hr.WeightKg, &hr.Quality, &fn, &hr.Notes, &hr.Strain); err != nil {
			hRows.Close()
			return err
		}
		if fn.Valid {
			v := int(fn.Int64)
			hr.FlushNum = &v
		}
		rd.Harvests = append(rd.Harvests, hr)
		rd.TotalKg += hr.WeightKg
		rd.StrainTotals[hr.Strain] += hr.WeightKg
	}
	hRows.Close()

	// Contam events in window
	q = `SELECT e.id, e.batch_id, e.event_type, e.ts, COALESCE(e.notes,''), COALESCE(e.payload,''),
	            COALESCE(b.strain,'')
	     FROM events e JOIN batches b ON b.id = e.batch_id
	     WHERE e.event_type IN ('contam','cull') AND e.ts >= ?` + strainFilter + ` ORDER BY e.ts ASC`
	args = append([]any{rd.Since}, strainArgs...)
	eRows, err := conn.QueryContext(ctx, q, args...)
	if err != nil {
		return err
	}
	for eRows.Next() {
		var er reportEventRow
		var payload string
		if err := eRows.Scan(&er.ID, &er.BatchID, &er.EventType, &er.TS, &er.Notes, &payload, &er.Strain); err != nil {
			eRows.Close()
			return err
		}
		if payload != "" {
			er.Payload = json.RawMessage(payload)
		}
		rd.Contam = append(rd.Contam, er)
	}
	eRows.Close()

	// State counts (all-time, filtered by strain)
	q = `SELECT
	       SUM(CASE WHEN state='active' THEN 1 ELSE 0 END),
	       SUM(CASE WHEN state='culled' THEN 1 ELSE 0 END),
	       SUM(CASE WHEN state='finished' THEN 1 ELSE 0 END)
	     FROM batches b WHERE 1=1` + strainFilter
	row := conn.QueryRowContext(ctx, q, strainArgs...)
	var a, c, f sql.NullInt64
	if err := row.Scan(&a, &c, &f); err != nil {
		return err
	}
	rd.ActiveCount = int(a.Int64)
	rd.CulledCount = int(c.Int64)
	rd.FinishedCount = int(f.Int64)
	return nil
}

func renderReport(rd *reportData, days int) string {
	var b strings.Builder
	title := fmt.Sprintf("Crowe Farm Report — last %d day%s", days, plural(days))
	if rd.Strain != "" {
		title += " — " + rd.Strain
	}
	fmt.Fprintf(&b, "# %s\n\n", title)
	fmt.Fprintf(&b, "_Generated %s. Window: %s -> %s._\n\n",
		time.Now().UTC().Format("2006-01-02 15:04 UTC"),
		rd.Since[:10], rd.Until[:10])

	// Top-line numbers
	fmt.Fprintf(&b, "## At a glance\n\n")
	fmt.Fprintf(&b, "| Metric | Value |\n|---|---|\n")
	fmt.Fprintf(&b, "| New batches started | %d |\n", len(rd.NewBatches))
	fmt.Fprintf(&b, "| Harvests recorded | %d |\n", len(rd.Harvests))
	fmt.Fprintf(&b, "| Total fresh weight | %.3f kg |\n", rd.TotalKg)
	fmt.Fprintf(&b, "| Contam / cull events | %d |\n", len(rd.Contam))
	fmt.Fprintf(&b, "| Active batches (all time) | %d |\n", rd.ActiveCount)
	fmt.Fprintf(&b, "| Culled lifetime | %d |\n", rd.CulledCount)
	fmt.Fprintf(&b, "| Finished lifetime | %d |\n\n", rd.FinishedCount)

	// Yield by strain
	if len(rd.StrainTotals) > 0 {
		fmt.Fprintf(&b, "## Yield by strain (this window)\n\n")
		strains := make([]string, 0, len(rd.StrainTotals))
		for s := range rd.StrainTotals {
			strains = append(strains, s)
		}
		sort.Slice(strains, func(i, j int) bool {
			return rd.StrainTotals[strains[i]] > rd.StrainTotals[strains[j]]
		})
		fmt.Fprintf(&b, "| Strain | Weight (kg) |\n|---|---|\n")
		for _, s := range strains {
			label := s
			if label == "" {
				label = "_(unspecified)_"
			}
			fmt.Fprintf(&b, "| %s | %.3f |\n", label, rd.StrainTotals[s])
		}
		fmt.Fprintln(&b)
	}

	// New batches
	if len(rd.NewBatches) > 0 {
		fmt.Fprintf(&b, "## New batches\n\n")
		for _, batch := range rd.NewBatches {
			parent := ""
			if batch.ParentID != nil {
				parent = fmt.Sprintf(" (from #%d)", *batch.ParentID)
			}
			weight := ""
			if batch.WeightKg != nil {
				weight = fmt.Sprintf(" %.2fkg", *batch.WeightKg)
			}
			fmt.Fprintf(&b, "- **#%d** %s — %s%s%s — %s\n",
				batch.ID, batch.Kind, batch.Strain, parent, weight, batch.StartedAt[:10])
			if batch.Notes != "" {
				fmt.Fprintf(&b, "    > %s\n", batch.Notes)
			}
		}
		fmt.Fprintln(&b)
	}

	// Harvests
	if len(rd.Harvests) > 0 {
		fmt.Fprintf(&b, "## Harvests\n\n")
		for _, h := range rd.Harvests {
			flush := ""
			if h.FlushNum != nil {
				flush = fmt.Sprintf(" flush %d", *h.FlushNum)
			}
			quality := ""
			if h.Quality != "" {
				quality = " grade " + h.Quality
			}
			fmt.Fprintf(&b, "- batch #%d (%s): %.3fkg%s%s — %s\n",
				h.BatchID, h.Strain, h.WeightKg, quality, flush, h.TS[:10])
			if h.Notes != "" {
				fmt.Fprintf(&b, "    > %s\n", h.Notes)
			}
		}
		fmt.Fprintln(&b)
	}

	// Contam / cull
	if len(rd.Contam) > 0 {
		fmt.Fprintf(&b, "## Contamination + culls\n\n")
		for _, e := range rd.Contam {
			fmt.Fprintf(&b, "- batch #%d (%s) — %s — %s\n",
				e.BatchID, e.Strain, e.EventType, e.TS[:10])
			if e.Notes != "" {
				fmt.Fprintf(&b, "    > %s\n", e.Notes)
			}
		}
		fmt.Fprintln(&b)
	}

	if len(rd.NewBatches) == 0 && len(rd.Harvests) == 0 && len(rd.Contam) == 0 {
		fmt.Fprintf(&b, "_No activity in this window._\n")
	}

	return b.String()
}

func plural(n int) string {
	if n == 1 {
		return ""
	}
	return "s"
}
