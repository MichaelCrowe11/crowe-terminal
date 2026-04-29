// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

// crowe-farm is the standalone CLI for the cultivation operations log.
// Reads/writes the same SQLite file the agent's ct_farm_* tools use, so
// you can journal from a terminal SSH'd into the grow room without
// launching the Crowe Terminal GUI.
//
// All subcommands are thin wrappers over the handlers in
// pkg/agent/tools/farm — same validation, same schema, same data.
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/spf13/cobra"

	farm "github.com/wavetermdev/waveterm/pkg/agent/tools/farm"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func main() {
	root := &cobra.Command{
		Use:   "crowe-farm",
		Short: "Cultivation operations log — batches, events, harvests, sensors",
		Long: `crowe-farm is the standalone CLI for the Crowe Terminal cultivation log.

Reads and writes the same SQLite file that the AI agent uses
(~/Library/Application Support/crowe-terminal/farmlog.db on macOS),
so chat-side and CLI-side work share state.

Common flows:

  crowe-farm batch start --kind grain --strain "Lions Mane" --substrate "rye 4lb"
  crowe-farm event 12 inoculate --notes "2ml LC each, 5 jars"
  crowe-farm harvest 14 0.42 --quality A --flush 1
  crowe-farm list --strain "Lions Mane" --active
  crowe-farm history 14
  crowe-farm yield --since 2026-04-01
  crowe-farm report --days 7
  crowe-farm sensor 14 --temp-f 62 --humidity 92 --co2 850
  crowe-farm export --out ~/farm-export
  crowe-farm sync                # needs CROWE_FARM_SYNC_TOKEN`,
		SilenceUsage: true,
	}

	root.AddCommand(
		batchCmd(),
		eventCmd(),
		harvestCmd(),
		listCmd(),
		historyCmd(),
		yieldCmd(),
		reportCmd(),
		exportCmd(),
		sensorCmd(),
		sensorSummaryCmd(),
		stateCmd(),
		syncCmd(),
		dbPathCmd(),
	)

	if err := root.Execute(); err != nil {
		os.Exit(1)
	}
}

// callTool is the bridge from a CLI subcommand into the registered
// handler. We use the same registry the agent uses so behavior matches
// exactly. args are the JSON arguments the tool expects.
func callTool(name string, args map[string]any) (json.RawMessage, error) {
	body, err := json.Marshal(args)
	if err != nil {
		return nil, err
	}
	res, err := registry.Default().Call(context.Background(), registry.CallRequest{
		Name:      name,
		Arguments: body,
	})
	if err != nil && !res.IsError {
		return nil, err
	}
	if res.IsError {
		return nil, fmt.Errorf("%s", res.ErrorText)
	}
	return res.Content, nil
}

func mustCallAndPrint(name string, args map[string]any) {
	out, err := callTool(name, args)
	if err != nil {
		fmt.Fprintln(os.Stderr, "error:", err)
		os.Exit(1)
	}
	pretty(out)
}

func pretty(raw json.RawMessage) {
	var v any
	if err := json.Unmarshal(raw, &v); err != nil {
		fmt.Println(string(raw))
		return
	}
	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	_ = enc.Encode(v)
}

// ----- batch -----

func batchCmd() *cobra.Command {
	c := &cobra.Command{Use: "batch", Short: "Manage cultivation batches"}

	start := &cobra.Command{
		Use:   "start",
		Short: "Start a new batch (grain jar, fruiting bag, agar plate, etc.)",
		Run: func(cmd *cobra.Command, _ []string) {
			args := map[string]any{}
			setIfFlag(cmd, "kind", &args, "kind")
			setIfFlag(cmd, "strain", &args, "strain")
			setIfFlag(cmd, "substrate", &args, "substrate")
			setFloatIfFlag(cmd, "weight", &args, "weight_kg")
			setIfFlag(cmd, "tech", &args, "technician")
			setInt64IfFlag(cmd, "parent", &args, "parent_id")
			setIfFlag(cmd, "notes", &args, "notes")
			setIfFlag(cmd, "started", &args, "started_at")
			mustCallAndPrint("farm.batch_start", args)
		},
	}
	start.Flags().String("kind", "", "grain | sawdust | bag | bulk | agar | clone | other (required)")
	start.Flags().String("strain", "", "Strain or species")
	start.Flags().String("substrate", "", "Recipe / source (e.g. 'sterilized rye 4lb')")
	start.Flags().Float64("weight", 0, "Wet weight in kg")
	start.Flags().String("tech", "", "Technician name")
	start.Flags().Int64("parent", 0, "Parent batch_id (lineage from inoculation source)")
	start.Flags().String("notes", "", "Free-form notes")
	start.Flags().String("started", "", "ISO8601 timestamp (default: now)")
	_ = start.MarkFlagRequired("kind")

	c.AddCommand(start)
	return c
}

// ----- event -----

func eventCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "event <batch_id> <event_type>",
		Short: "Record an event (inoculate, transfer, fruiting_init, contam, fae, water, cull, note)",
		Args:  cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			id, err := parseInt(args[0])
			if err != nil {
				exit("bad batch_id: %v", err)
			}
			payload := map[string]any{}
			if p, _ := cmd.Flags().GetString("payload"); p != "" {
				if err := json.Unmarshal([]byte(p), &payload); err != nil {
					exit("bad --payload JSON: %v", err)
				}
			}
			req := map[string]any{
				"batch_id":   id,
				"event_type": args[1],
			}
			setIfFlag(cmd, "notes", &req, "notes")
			setIfFlag(cmd, "ts", &req, "ts")
			if len(payload) > 0 {
				req["payload"] = payload
			}
			mustCallAndPrint("farm.event", req)
		},
	}
	c.Flags().String("notes", "", "Free-form notes")
	c.Flags().String("payload", "", "Structured JSON payload (e.g. '{\"jar_count\":5}')")
	c.Flags().String("ts", "", "ISO8601 timestamp (default: now)")
	return c
}

// ----- harvest -----

func harvestCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "harvest <batch_id> <weight_kg>",
		Short: "Record a harvest off a fruiting batch",
		Args:  cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			id, err := parseInt(args[0])
			if err != nil {
				exit("bad batch_id: %v", err)
			}
			w, err := parseFloat(args[1])
			if err != nil {
				exit("bad weight: %v", err)
			}
			req := map[string]any{
				"batch_id":  id,
				"weight_kg": w,
			}
			setIfFlag(cmd, "quality", &req, "quality")
			setIntIfFlag(cmd, "flush", &req, "flush_num")
			setIfFlag(cmd, "notes", &req, "notes")
			setIfFlag(cmd, "ts", &req, "ts")
			mustCallAndPrint("farm.harvest", req)
		},
	}
	c.Flags().String("quality", "", "A | B | C | cull")
	c.Flags().Int("flush", 0, "Flush number 1, 2, 3...")
	c.Flags().String("notes", "", "Free-form notes")
	c.Flags().String("ts", "", "ISO8601 timestamp")
	return c
}

// ----- list -----

func listCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "list",
		Short: "List batches with optional filters",
		Run: func(cmd *cobra.Command, _ []string) {
			req := map[string]any{}
			if active, _ := cmd.Flags().GetBool("active"); active {
				req["state"] = "active"
			}
			setIfFlag(cmd, "state", &req, "state")
			setIfFlag(cmd, "strain", &req, "strain")
			setIfFlag(cmd, "kind", &req, "kind")
			setIfFlag(cmd, "since", &req, "since")
			setIntIfFlag(cmd, "limit", &req, "limit")

			out, err := callTool("farm.list_batches", req)
			if err != nil {
				exit("%v", err)
			}
			if format, _ := cmd.Flags().GetString("format"); format == "json" {
				pretty(out)
				return
			}
			renderBatchTable(out)
		},
	}
	c.Flags().Bool("active", false, "Shorthand for --state active")
	c.Flags().String("state", "", "active | culled | finished")
	c.Flags().String("strain", "", "Filter by strain")
	c.Flags().String("kind", "", "Filter by kind")
	c.Flags().String("since", "", "ISO date — only batches started on/after")
	c.Flags().Int("limit", 50, "Max rows")
	c.Flags().String("format", "table", "table | json")
	return c
}

func renderBatchTable(raw json.RawMessage) {
	var resp struct {
		Count   int          `json:"count"`
		Batches []farm.Batch `json:"batches"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		fmt.Println(string(raw))
		return
	}
	if resp.Count == 0 {
		fmt.Println("(no batches match)")
		return
	}
	fmt.Printf("%-5s %-8s %-20s %-9s %-12s %s\n", "ID", "KIND", "STRAIN", "STATE", "STARTED", "NOTES")
	for _, b := range resp.Batches {
		started := b.StartedAt
		if len(started) >= 10 {
			started = started[:10]
		}
		notes := b.Notes
		if len(notes) > 40 {
			notes = notes[:37] + "..."
		}
		strain := b.Strain
		if len(strain) > 18 {
			strain = strain[:18]
		}
		fmt.Printf("%-5d %-8s %-20s %-9s %-12s %s\n", b.ID, b.Kind, strain, b.State, started, notes)
	}
	fmt.Printf("\n%d batches\n", resp.Count)
}

// ----- history -----

func historyCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "history <batch_id>",
		Short: "Full lineage of a batch — events + harvests in time order",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			id, err := parseInt(args[0])
			if err != nil {
				exit("bad batch_id: %v", err)
			}
			out, err := callTool("farm.batch_history", map[string]any{"batch_id": id})
			if err != nil {
				exit("%v", err)
			}
			if f, _ := cmd.Flags().GetString("format"); f == "json" {
				pretty(out)
				return
			}
			renderHistory(out)
		},
	}
	c.Flags().String("format", "tree", "tree | json")
	return c
}

func renderHistory(raw json.RawMessage) {
	var resp struct {
		Batch    farm.Batch    `json:"batch"`
		Events   []farm.Event  `json:"events"`
		Harvests []farm.Harvest `json:"harvests"`
	}
	if err := json.Unmarshal(raw, &resp); err != nil {
		fmt.Println(string(raw))
		return
	}
	b := resp.Batch
	fmt.Printf("Batch #%d  %s — %s  (%s)\n", b.ID, b.Kind, b.Strain, b.State)
	if b.Substrate != "" {
		fmt.Printf("  substrate: %s\n", b.Substrate)
	}
	if b.WeightKg != nil {
		fmt.Printf("  weight:    %.2fkg\n", *b.WeightKg)
	}
	if b.Technician != "" {
		fmt.Printf("  by:        %s\n", b.Technician)
	}
	if b.ParentID != nil {
		fmt.Printf("  parent:    #%d\n", *b.ParentID)
	}
	fmt.Printf("  started:   %s\n", b.StartedAt)
	if b.Notes != "" {
		fmt.Printf("  notes:     %s\n", b.Notes)
	}
	if len(resp.Events) > 0 {
		fmt.Printf("\nEvents (%d):\n", len(resp.Events))
		for _, e := range resp.Events {
			ts := e.TS
			if len(ts) >= 19 {
				ts = ts[:19]
			}
			line := fmt.Sprintf("  %s  %-15s %s", ts, e.EventType, e.Notes)
			fmt.Println(strings.TrimRight(line, " "))
			if len(e.Payload) > 0 {
				fmt.Printf("                       payload: %s\n", string(e.Payload))
			}
		}
	}
	if len(resp.Harvests) > 0 {
		fmt.Printf("\nHarvests (%d):\n", len(resp.Harvests))
		for _, h := range resp.Harvests {
			flush := ""
			if h.FlushNum != nil {
				flush = fmt.Sprintf(" flush %d", *h.FlushNum)
			}
			ts := h.TS
			if len(ts) >= 19 {
				ts = ts[:19]
			}
			fmt.Printf("  %s  %.3fkg  grade=%s%s  %s\n", ts, h.WeightKg, h.Quality, flush, h.Notes)
		}
	}
}

// ----- yield -----

func yieldCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "yield",
		Short: "Aggregate yield, contamination rate, batch counts",
		Run: func(cmd *cobra.Command, _ []string) {
			req := map[string]any{}
			setIfFlag(cmd, "strain", &req, "strain")
			setIfFlag(cmd, "since", &req, "since")
			out, err := callTool("farm.yield_summary", req)
			if err != nil {
				exit("%v", err)
			}
			var ys map[string]any
			_ = json.Unmarshal(out, &ys)
			fmt.Printf("Batches:        %v\n", ys["batch_count"])
			fmt.Printf("Active:         %v\n", val(ys, "batch_count", 0).(float64)-val(ys, "culled_count", 0).(float64)-val(ys, "finished_count", 0).(float64))
			fmt.Printf("Culled:         %v\n", ys["culled_count"])
			fmt.Printf("Finished:       %v\n", ys["finished_count"])
			fmt.Printf("Harvests:       %v\n", ys["harvest_count"])
			fmt.Printf("Total weight:   %.3f kg\n", val(ys, "total_weight_kg", 0.0).(float64))
			fmt.Printf("Avg / batch:    %.3f kg\n", val(ys, "avg_kg_per_batch", 0.0).(float64))
			fmt.Printf("Contam rate:    %.1f%%\n", val(ys, "contam_rate", 0.0).(float64)*100)
		},
	}
	c.Flags().String("strain", "", "Filter by strain")
	c.Flags().String("since", "", "ISO date — only count batches started on/after")
	return c
}

func val(m map[string]any, key string, def any) any {
	if v, ok := m[key]; ok && v != nil {
		return v
	}
	return def
}

// ----- report -----

func reportCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "report",
		Short: "Markdown summary of the last N days",
		Run: func(cmd *cobra.Command, _ []string) {
			req := map[string]any{}
			setIntIfFlag(cmd, "days", &req, "days")
			setIfFlag(cmd, "strain", &req, "strain")
			setIfFlag(cmd, "out", &req, "out_path")
			out, err := callTool("farm.report", req)
			if err != nil {
				exit("%v", err)
			}
			var resp struct {
				Markdown   string `json:"markdown"`
				WrittenTo  string `json:"written_to,omitempty"`
				NewBatches int    `json:"new_batches"`
			}
			_ = json.Unmarshal(out, &resp)
			fmt.Print(resp.Markdown)
			if resp.WrittenTo != "" {
				fmt.Fprintf(os.Stderr, "\n[written to %s]\n", resp.WrittenTo)
			}
		},
	}
	c.Flags().Int("days", 7, "How many days back to summarize")
	c.Flags().String("strain", "", "Filter by strain")
	c.Flags().String("out", "", "Write the markdown to this path")
	return c
}

// ----- export -----

func exportCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "export",
		Short: "Write batches.csv, events.csv, harvests.csv to a directory",
		Run: func(cmd *cobra.Command, _ []string) {
			req := map[string]any{}
			setIfFlag(cmd, "out", &req, "out_dir")
			setIfFlag(cmd, "since", &req, "since")
			mustCallAndPrint("farm.export_csv", req)
		},
	}
	c.Flags().String("out", "", "Output directory (default: ~/Documents/crowe-farm-export-YYYYMMDD/)")
	c.Flags().String("since", "", "ISO date — only export batches started on/after")
	return c
}

// ----- sensor -----

func sensorCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "sensor <batch_id>",
		Short: "Log a sensor reading (temperature, humidity, CO2, light)",
		Args:  cobra.ExactArgs(1),
		Run: func(cmd *cobra.Command, args []string) {
			id, err := parseInt(args[0])
			if err != nil {
				exit("bad batch_id: %v", err)
			}
			req := map[string]any{"batch_id": id}
			setFloatIfFlag(cmd, "temp-f", &req, "temp_f")
			setFloatIfFlag(cmd, "temp-c", &req, "temp_c")
			setFloatIfFlag(cmd, "humidity", &req, "humidity")
			setFloatIfFlag(cmd, "co2", &req, "co2_ppm")
			setFloatIfFlag(cmd, "lux", &req, "light_lux")
			setIfFlag(cmd, "source", &req, "source")
			setIfFlag(cmd, "notes", &req, "notes")
			mustCallAndPrint("farm.log_sensor", req)
		},
	}
	c.Flags().Float64("temp-f", 0, "Temperature in Fahrenheit")
	c.Flags().Float64("temp-c", 0, "Temperature in Celsius (auto-converted)")
	c.Flags().Float64("humidity", 0, "Relative humidity %")
	c.Flags().Float64("co2", 0, "CO2 in ppm")
	c.Flags().Float64("lux", 0, "Light in lux")
	c.Flags().String("source", "", "Probe / source name")
	c.Flags().String("notes", "", "Free-form notes")
	return c
}

func sensorSummaryCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "sensor-summary",
		Short: "Aggregate sensor readings (min/avg/max)",
		Run: func(cmd *cobra.Command, _ []string) {
			req := map[string]any{}
			setInt64IfFlag(cmd, "batch", &req, "batch_id")
			setIfFlag(cmd, "since", &req, "since")
			out, err := callTool("farm.sensor_summary", req)
			if err != nil {
				exit("%v", err)
			}
			var s map[string]any
			_ = json.Unmarshal(out, &s)
			for _, key := range []string{"temp_f", "humidity", "co2_ppm", "light_lux"} {
				agg, ok := s[key].(map[string]any)
				if !ok {
					continue
				}
				fmt.Printf("%-10s  min=%-8.2f avg=%-8.2f max=%-8.2f n=%v\n",
					key, agg["min"], agg["avg"], agg["max"], agg["count"])
			}
		},
	}
	c.Flags().Int64("batch", 0, "Batch id (omit for all batches)")
	c.Flags().String("since", "", "ISO date")
	return c
}

// ----- state -----

func stateCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "state <batch_id> <new_state>",
		Short: "Change batch state — active | culled | finished",
		Args:  cobra.ExactArgs(2),
		Run: func(cmd *cobra.Command, args []string) {
			id, err := parseInt(args[0])
			if err != nil {
				exit("bad batch_id: %v", err)
			}
			req := map[string]any{"batch_id": id, "state": args[1]}
			setIfFlag(cmd, "notes", &req, "notes")
			mustCallAndPrint("farm.update_state", req)
		},
	}
	c.Flags().String("notes", "", "Reason / context")
	return c
}

// ----- sync -----

func syncCmd() *cobra.Command {
	c := &cobra.Command{
		Use:   "sync",
		Short: "Push local log to Crowe Logic AI Platform (needs CROWE_FARM_SYNC_TOKEN)",
		Run: func(cmd *cobra.Command, _ []string) {
			req := map[string]any{}
			setIfFlag(cmd, "since", &req, "since")
			setIfFlag(cmd, "url", &req, "url")
			setIfFlag(cmd, "client", &req, "client_id")
			out, err := callTool("farm.sync_platform", req)
			if err != nil {
				exit("%v", err)
			}
			pretty(out)
		},
	}
	c.Flags().String("since", "", "ISO date — only send batches started on/after")
	c.Flags().String("url", "", "Override destination URL")
	c.Flags().String("client", "", "Client/farm identifier")
	return c
}

// ----- db-path -----

func dbPathCmd() *cobra.Command {
	return &cobra.Command{
		Use:   "db-path",
		Short: "Print the path to the SQLite file (use with sqlite3 directly)",
		Run: func(_ *cobra.Command, _ []string) {
			fmt.Println(farm.DBPathForTesting())
		},
	}
}

// ----- helpers -----

func setIfFlag(cmd *cobra.Command, flag string, m *map[string]any, key string) {
	v, _ := cmd.Flags().GetString(flag)
	if v != "" {
		(*m)[key] = v
	}
}

func setIntIfFlag(cmd *cobra.Command, flag string, m *map[string]any, key string) {
	v, _ := cmd.Flags().GetInt(flag)
	if v != 0 {
		(*m)[key] = v
	}
}

func setInt64IfFlag(cmd *cobra.Command, flag string, m *map[string]any, key string) {
	v, _ := cmd.Flags().GetInt64(flag)
	if v != 0 {
		(*m)[key] = v
	}
}

func setFloatIfFlag(cmd *cobra.Command, flag string, m *map[string]any, key string) {
	v, _ := cmd.Flags().GetFloat64(flag)
	if v != 0 {
		(*m)[key] = v
	}
}

func parseInt(s string) (int64, error) {
	var n int64
	_, err := fmt.Sscan(s, &n)
	return n, err
}

func parseFloat(s string) (float64, error) {
	var f float64
	_, err := fmt.Sscan(s, &f)
	return f, err
}

func exit(format string, args ...any) {
	fmt.Fprintf(os.Stderr, format+"\n", args...)
	os.Exit(1)
}
