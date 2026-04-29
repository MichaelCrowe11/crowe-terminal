// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"os"
	"sort"
	"strings"
	"time"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.sop_chapter",
		Description: "Generate a draft SOP chapter for a strain by combining the strain's reference " +
			"envelope with the operator's actual recent batches and harvests. Output is markdown the " +
			"user can paste into the Lion's Mane SOP (or other strain SOPs) and edit. Pulls real " +
			"numbers - substrate weights, flush counts, contam rate, biological efficiency.",
		Schema:   json.RawMessage(SchemaSOPChapter),
		Mutating: false,
		Handler:  handleSOPChapter,
	})
}

const SchemaSOPChapter = `{
  "type": "object",
  "properties": {
    "strain":   {"type":"string","description":"Strain name (matches farm.strain_info)"},
    "out_path": {"type":"string","description":"Optional file path to write the markdown to."},
    "since":    {"type":"string","description":"ISO date - only consider batches started on/after this. Default: 90 days ago."}
  },
  "required":["strain"],
  "additionalProperties":false
}`

type sopChapterArgs struct {
	Strain  string `json:"strain"`
	OutPath string `json:"out_path"`
	Since   string `json:"since"`
}

func handleSOPChapter(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args sopChapterArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	if strings.TrimSpace(args.Strain) == "" {
		return errResult(fmt.Errorf("strain required")), nil
	}
	if args.Since == "" {
		args.Since = time.Now().UTC().Add(-90 * 24 * time.Hour).Format(time.RFC3339)
	}

	info := lookupStrain(args.Strain)
	if info == nil {
		return errResult(fmt.Errorf("strain %q not found in catalog - call farm.list_strains", args.Strain)), nil
	}

	conn, err := getDB()
	if err != nil {
		return errResult(err), nil
	}

	// Pull batch + harvest data for this strain in window (alias-aware match)
	likes := append([]string{info.Name}, info.Aliases...)
	var batches []sopBatch
	for _, n := range likes {
		rows, err := conn.QueryContext(ctx, `
			SELECT b.id, b.kind, COALESCE(b.substrate,''), b.weight_kg, b.started_at, b.state,
			       (SELECT COUNT(*) FROM events e WHERE e.batch_id = b.id),
			       (SELECT COUNT(*) FROM harvests h WHERE h.batch_id = b.id),
			       (SELECT COALESCE(SUM(h.weight_kg),0) FROM harvests h WHERE h.batch_id = b.id)
			FROM batches b
			WHERE b.strain = ? COLLATE NOCASE AND b.started_at >= ?
			ORDER BY b.started_at ASC
		`, n, args.Since)
		if err != nil {
			return errResult(err), nil
		}
		for rows.Next() {
			var sb sopBatch
			var w sql.NullFloat64
			if err := rows.Scan(&sb.ID, &sb.Kind, &sb.Substrate, &w, &sb.StartedAt, &sb.State,
				&sb.EventCount, &sb.HarvestCount, &sb.HarvestKg); err != nil {
				rows.Close()
				return errResult(err), nil
			}
			if w.Valid {
				v := w.Float64
				sb.WeightKg = &v
			}
			batches = append(batches, sb)
		}
		rows.Close()
	}
	// dedupe in case aliases overlapped
	seen := map[int64]bool{}
	dedup := batches[:0]
	for _, b := range batches {
		if !seen[b.ID] {
			seen[b.ID] = true
			dedup = append(dedup, b)
		}
	}
	batches = dedup
	sort.Slice(batches, func(i, j int) bool { return batches[i].StartedAt < batches[j].StartedAt })

	md := renderSOPChapter(info, batches, args.Since)
	out := map[string]any{
		"strain":       info.Name,
		"since":        args.Since,
		"batches_used": len(batches),
		"markdown":     md,
	}
	if args.OutPath != "" {
		dir := args.OutPath
		if i := strings.LastIndex(dir, "/"); i > 0 {
			dir = dir[:i]
			_ = os.MkdirAll(dir, 0o755)
		}
		if err := os.WriteFile(args.OutPath, []byte(md), 0o644); err == nil {
			out["written_to"] = args.OutPath
		}
	}
	body, _ := json.Marshal(out)
	return registry.Result{Content: body}, nil
}

type sopBatch struct {
	ID           int64
	Kind         string
	Substrate    string
	WeightKg     *float64
	StartedAt    string
	State        string
	EventCount   int
	HarvestCount int
	HarvestKg    float64
}

func renderSOPChapter(info *StrainInfo, batches []sopBatch, since string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s - Cultivation SOP (Draft)\n\n", info.Name)
	if info.ScientificName != "" {
		fmt.Fprintf(&b, "_%s_\n\n", info.ScientificName)
	}
	fmt.Fprintf(&b, "_Auto-drafted %s from operating data since %s. Edit before publishing._\n\n",
		time.Now().UTC().Format("2006-01-02"), since[:10])

	fmt.Fprintf(&b, "## 1. Operating envelope (catalog defaults)\n\n")
	fmt.Fprintf(&b, "| Parameter | Range |\n|---|---|\n")
	fmt.Fprintf(&b, "| Grain substrate | %s |\n", info.GrainSubstrate)
	fmt.Fprintf(&b, "| Bulk substrate | %s |\n", info.BulkSubstrate)
	fmt.Fprintf(&b, "| Incubation duration | %d–%d days |\n", info.IncubationDays[0], info.IncubationDays[1])
	fmt.Fprintf(&b, "| Incubation temp | %d–%d °F |\n", info.IncubationTempF[0], info.IncubationTempF[1])
	fmt.Fprintf(&b, "| Fruiting temp | %d–%d °F |\n", info.FruitingTempF[0], info.FruitingTempF[1])
	fmt.Fprintf(&b, "| Humidity | %d–%d %% |\n", info.HumidityPercent[0], info.HumidityPercent[1])
	fmt.Fprintf(&b, "| Target CO₂ | %d–%d ppm |\n", info.CO2PPMTarget[0], info.CO2PPMTarget[1])
	fmt.Fprintf(&b, "| Fresh-air exchange | %d–%d /hr |\n", info.FAEPerHour[0], info.FAEPerHour[1])
	fmt.Fprintf(&b, "| Days between flushes | %d–%d |\n", info.FlushDays[0], info.FlushDays[1])
	fmt.Fprintf(&b, "| Biological efficiency | %d–%d %% |\n\n", info.BiologicalEffPct[0], info.BiologicalEffPct[1])

	if info.OperatingNotes != "" {
		fmt.Fprintf(&b, "**Operating notes:** %s\n\n", info.OperatingNotes)
	}
	if info.ContamRiskNotes != "" {
		fmt.Fprintf(&b, "**Contam risk:** %s\n\n", info.ContamRiskNotes)
	}

	// Operating data section
	fmt.Fprintf(&b, "## 2. Recent operating data\n\n")
	if len(batches) == 0 {
		fmt.Fprintf(&b, "_No batches in window. Run more cycles before this section is meaningful._\n\n")
	} else {
		var totalHarvest float64
		var totalSubstrate float64
		var culledCount, finishedCount, activeCount int
		for _, bb := range batches {
			totalHarvest += bb.HarvestKg
			if bb.WeightKg != nil {
				totalSubstrate += *bb.WeightKg
			}
			switch bb.State {
			case "culled":
				culledCount++
			case "finished":
				finishedCount++
			default:
				activeCount++
			}
		}
		fmt.Fprintf(&b, "Window contains **%d batches** (%d active, %d finished, %d culled).\n\n",
			len(batches), activeCount, finishedCount, culledCount)

		if totalSubstrate > 0 {
			be := totalHarvest / totalSubstrate * 100
			fmt.Fprintf(&b, "Realized biological efficiency: **%.1f %%** (%.2fkg harvested / %.2fkg substrate).\n",
				be, totalHarvest, totalSubstrate)
			lo, hi := info.BiologicalEffPct[0], info.BiologicalEffPct[1]
			switch {
			case int(be) < lo:
				fmt.Fprintf(&b, "_Below catalog range %d–%d %% - investigate substrate prep, FAE, harvest timing._\n\n", lo, hi)
			case int(be) > hi:
				fmt.Fprintf(&b, "_Above catalog range %d–%d %% - strong run; document what's working._\n\n", lo, hi)
			default:
				fmt.Fprintf(&b, "_Within catalog range %d–%d %%._\n\n", lo, hi)
			}
		}
		if culledCount > 0 || finishedCount > 0 {
			contamRate := float64(culledCount) / float64(len(batches)) * 100
			fmt.Fprintf(&b, "Contamination rate: **%.0f %%** (%d culled / %d total).\n\n",
				contamRate, culledCount, len(batches))
		}

		fmt.Fprintf(&b, "### Batch ledger\n\n")
		fmt.Fprintf(&b, "| Batch | Kind | Substrate | Started | State | Events | Flushes | Total kg |\n")
		fmt.Fprintf(&b, "|---|---|---|---|---|---|---|---|\n")
		for _, bb := range batches {
			sub := bb.Substrate
			if sub == "" {
				sub = "-"
			}
			fmt.Fprintf(&b, "| #%d | %s | %s | %s | %s | %d | %d | %.3f |\n",
				bb.ID, bb.Kind, sub, bb.StartedAt[:10], bb.State,
				bb.EventCount, bb.HarvestCount, bb.HarvestKg)
		}
		fmt.Fprintln(&b)
	}

	fmt.Fprintf(&b, "## 3. Standard procedure\n\n")
	fmt.Fprintf(&b, "1. **Substrate prep** - prepare %s for grain spawn; %s for bulk fruiting blocks.\n",
		info.GrainSubstrate, info.BulkSubstrate)
	fmt.Fprintf(&b, "2. **Inoculation** - sterile transfer to grain at incubation temp %d–%d °F.\n",
		info.IncubationTempF[0], info.IncubationTempF[1])
	fmt.Fprintf(&b, "3. **Grain colonization** - hold %d–%d days at incubation temp until 100%% colonized.\n",
		info.IncubationDays[0], info.IncubationDays[1])
	fmt.Fprintf(&b, "4. **Bulk transfer** - mix grain spawn into bulk substrate at appropriate ratio.\n")
	fmt.Fprintf(&b, "5. **Bulk colonization** - hold at incubation temp until fully colonized.\n")
	fmt.Fprintf(&b, "6. **Fruiting initiation** - drop temp to %d–%d °F, raise humidity to %d–%d %%, set FAE to %d–%d /hr.\n",
		info.FruitingTempF[0], info.FruitingTempF[1],
		info.HumidityPercent[0], info.HumidityPercent[1],
		info.FAEPerHour[0], info.FAEPerHour[1])
	fmt.Fprintf(&b, "7. **Pinning** - primordia appear within ~3–7 days of fruiting init.\n")
	fmt.Fprintf(&b, "8. **Harvest** - pick at peak fruit body maturity (strain-specific, see operating notes).\n")
	fmt.Fprintf(&b, "9. **Flush cycle** - rest, mist, and re-pin every %d–%d days.\n",
		info.FlushDays[0], info.FlushDays[1])
	fmt.Fprintf(&b, "10. **End of cycle** - when biological efficiency plateaus or contam appears, mark batch finished/culled.\n\n")

	fmt.Fprintf(&b, "## 4. Logging requirements\n\n")
	fmt.Fprintf(&b, "Every batch must record:\n\n")
	fmt.Fprintf(&b, "- `batch_start` - substrate weight, technician, parent grain ID\n")
	fmt.Fprintf(&b, "- `event(inoculate)` - LC strain, ml per jar/bag, jar count\n")
	fmt.Fprintf(&b, "- `event(transfer)` - when grain → bulk\n")
	fmt.Fprintf(&b, "- `event(fruiting_init)` - date + room conditions snapshot\n")
	fmt.Fprintf(&b, "- `event(sensor)` - once daily at minimum during fruiting\n")
	fmt.Fprintf(&b, "- `event(photo)` - at flush peak for QC reference\n")
	fmt.Fprintf(&b, "- `harvest` - weight, quality grade, flush number\n")
	fmt.Fprintf(&b, "- `event(contam)` - type, location, response - if applicable\n")
	fmt.Fprintf(&b, "- `update_state(finished|culled)` - at end of cycle\n\n")

	fmt.Fprintf(&b, "## 5. Quality gates\n\n")
	fmt.Fprintf(&b, "Block release of harvest if any of:\n\n")
	fmt.Fprintf(&b, "- Visible contamination (any color other than mycelium white / strain-typical fruit body color)\n")
	fmt.Fprintf(&b, "- Off odor (sour, ammonia, sulfurous)\n")
	fmt.Fprintf(&b, "- Substrate moisture below spec at harvest\n")
	fmt.Fprintf(&b, "- Fruit body morphology atypical for strain\n\n")

	fmt.Fprintf(&b, "---\n_End auto-draft. Add cleaning protocols, room schematics, supplier list, and lot tracking before publishing._\n")
	return b.String()
}
