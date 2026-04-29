// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package farm

import (
	"context"
	"encoding/json"
	"strings"

	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

// StrainInfo captures the operating envelope for a single cultivar.
// Values are sourced from Crowe Logic's commercial cultivation playbook
// - they're starting points, not gospel. Override per-batch via notes.
type StrainInfo struct {
	Name              string   `json:"name"`
	ScientificName    string   `json:"scientific_name,omitempty"`
	Aliases           []string `json:"aliases,omitempty"`
	GrainSubstrate    string   `json:"grain_substrate"`
	BulkSubstrate     string   `json:"bulk_substrate"`
	IncubationDays    [2]int   `json:"incubation_days"`     // min/max
	IncubationTempF   [2]int   `json:"incubation_temp_f"`   // min/max
	FruitingTempF     [2]int   `json:"fruiting_temp_f"`     // min/max
	HumidityPercent   [2]int   `json:"humidity_percent"`    // min/max
	CO2PPMTarget      [2]int   `json:"co2_ppm_target"`      // min/max
	FAEPerHour        [2]int   `json:"fae_per_hour"`        // min/max
	FlushDays         [2]int   `json:"flush_days"`          // typical days between flushes
	BiologicalEffPct  [2]int   `json:"biological_eff_pct"`  // expected BE range
	ContamRiskNotes   string   `json:"contam_risk_notes,omitempty"`
	OperatingNotes    string   `json:"operating_notes,omitempty"`
}

// strainCatalog is the built-in starter set. Users can extend by writing
// to the same structure (future: load overrides from
// ~/Library/Application Support/crowe-terminal/strains.json).
var strainCatalog = []StrainInfo{
	{
		Name:           "Lions Mane",
		ScientificName: "Hericium erinaceus",
		Aliases:        []string{"lion's mane", "hericium", "pom pom"},
		GrainSubstrate: "sterilized rye 4lb",
		BulkSubstrate:  "hardwood + soy hull master mix",
		IncubationDays:    [2]int{14, 21},
		IncubationTempF:   [2]int{70, 75},
		FruitingTempF:     [2]int{60, 65},
		HumidityPercent:   [2]int{85, 95},
		CO2PPMTarget:      [2]int{500, 1000},
		FAEPerHour:        [2]int{4, 6},
		FlushDays:         [2]int{10, 14},
		BiologicalEffPct:  [2]int{50, 90},
		ContamRiskNotes:   "Low contam risk vs oysters. Watch for Trichoderma on stalled grain.",
		OperatingNotes:    "Wants high humidity + steady FAE. Reduce CO2 for tighter clusters; allow CO2 to climb for elongated 'pom-pom' shape.",
	},
	{
		Name:           "Blue Oyster",
		ScientificName: "Pleurotus ostreatus var. columbinus",
		Aliases:        []string{"blue oyster", "columbinus"},
		GrainSubstrate: "sterilized rye or millet",
		BulkSubstrate:  "pasteurized straw + supplement",
		IncubationDays:    [2]int{10, 14},
		IncubationTempF:   [2]int{72, 78},
		FruitingTempF:     [2]int{55, 65},
		HumidityPercent:   [2]int{85, 92},
		CO2PPMTarget:      [2]int{600, 1000},
		FAEPerHour:        [2]int{4, 8},
		FlushDays:         [2]int{7, 10},
		BiologicalEffPct:  [2]int{60, 100},
		ContamRiskNotes:   "Aggressive colonizer; outcompetes most contam if substrate is in spec.",
		OperatingNotes:    "Cold shock at fruiting init helps trigger pinning. Aggressive - fast cycle.",
	},
	{
		Name:           "Pink Oyster",
		ScientificName: "Pleurotus djamor",
		Aliases:        []string{"pink oyster", "djamor", "flamingo oyster"},
		GrainSubstrate: "sterilized rye or millet",
		BulkSubstrate:  "pasteurized straw + supplement",
		IncubationDays:    [2]int{7, 12},
		IncubationTempF:   [2]int{75, 85},
		FruitingTempF:     [2]int{70, 85},
		HumidityPercent:   [2]int{85, 90},
		CO2PPMTarget:      [2]int{500, 800},
		FAEPerHour:        [2]int{6, 10},
		FlushDays:         [2]int{5, 8},
		BiologicalEffPct:  [2]int{40, 70},
		ContamRiskNotes:   "Heat-loving - sensitive to cold spots. Short shelf life post-harvest.",
		OperatingNotes:    "Warmest oyster. Doesn't want refrigeration before processing.",
	},
	{
		Name:           "Yellow Oyster",
		ScientificName: "Pleurotus citrinopileatus",
		Aliases:        []string{"yellow oyster", "golden oyster", "citrinopileatus"},
		GrainSubstrate: "sterilized rye or millet",
		BulkSubstrate:  "pasteurized straw + supplement",
		IncubationDays:    [2]int{10, 14},
		IncubationTempF:   [2]int{75, 80},
		FruitingTempF:     [2]int{65, 75},
		HumidityPercent:   [2]int{85, 92},
		CO2PPMTarget:      [2]int{500, 900},
		FAEPerHour:        [2]int{5, 8},
		FlushDays:         [2]int{7, 10},
		BiologicalEffPct:  [2]int{50, 80},
		ContamRiskNotes:   "Similar to pink; heat-loving variants.",
		OperatingNotes:    "Stunning yellow caps fade to tan with age - harvest before full flatten.",
	},
	{
		Name:           "King Trumpet",
		ScientificName: "Pleurotus eryngii",
		Aliases:        []string{"king trumpet", "king oyster", "eryngii"},
		GrainSubstrate: "sterilized rye 4lb",
		BulkSubstrate:  "supplemented hardwood (15-20% supplement)",
		IncubationDays:    [2]int{18, 25},
		IncubationTempF:   [2]int{70, 75},
		FruitingTempF:     [2]int{55, 60},
		HumidityPercent:   [2]int{85, 90},
		CO2PPMTarget:      [2]int{1000, 2000},
		FAEPerHour:        [2]int{1, 3},
		FlushDays:         [2]int{14, 21},
		BiologicalEffPct:  [2]int{50, 80},
		ContamRiskNotes:   "Wants high CO2 and slow FAE - opposite of oysters. Prone to bacterial blotch if humidity too high.",
		OperatingNotes:    "Bottle culture style. CO2 push for long stems. Single primordium per bottle is the goal.",
	},
	{
		Name:           "Shiitake",
		ScientificName: "Lentinula edodes",
		Aliases:        []string{"shiitake", "lentinula"},
		GrainSubstrate: "sterilized rye sawdust mix",
		BulkSubstrate:  "hardwood sawdust + bran block",
		IncubationDays:    [2]int{45, 90},
		IncubationTempF:   [2]int{70, 75},
		FruitingTempF:     [2]int{55, 70},
		HumidityPercent:   [2]int{80, 90},
		CO2PPMTarget:      [2]int{500, 1500},
		FAEPerHour:        [2]int{4, 6},
		FlushDays:         [2]int{14, 28},
		BiologicalEffPct:  [2]int{50, 100},
		ContamRiskNotes:   "Long incubation = high risk window. Browning of block face is normal, not contam.",
		OperatingNotes:    "Cold shock + soak between flushes. Can produce 4+ flushes from one block.",
	},
	{
		Name:           "Reishi",
		ScientificName: "Ganoderma lucidum",
		Aliases:        []string{"reishi", "ganoderma", "lingzhi"},
		GrainSubstrate: "sterilized millet or rye",
		BulkSubstrate:  "hardwood sawdust + bran",
		IncubationDays:    [2]int{30, 60},
		IncubationTempF:   [2]int{75, 80},
		FruitingTempF:     [2]int{75, 85},
		HumidityPercent:   [2]int{85, 95},
		CO2PPMTarget:      [2]int{2000, 5000},
		FAEPerHour:        [2]int{1, 2},
		FlushDays:         [2]int{30, 60},
		BiologicalEffPct:  [2]int{20, 40},
		ContamRiskNotes:   "Slow-growing, vulnerable early. Once colonized, very resistant.",
		OperatingNotes:    "High CO2 / low FAE for antler form. Open environment for conk form.",
	},
	{
		Name:           "Cordyceps militaris",
		ScientificName: "Cordyceps militaris",
		Aliases:        []string{"cordyceps", "militaris"},
		GrainSubstrate: "rice + nutrient broth (jar culture)",
		BulkSubstrate:  "(none - fruits on grain substrate)",
		IncubationDays:    [2]int{14, 21},
		IncubationTempF:   [2]int{68, 72},
		FruitingTempF:     [2]int{65, 75},
		HumidityPercent:   [2]int{85, 95},
		CO2PPMTarget:      [2]int{500, 1000},
		FAEPerHour:        [2]int{3, 5},
		FlushDays:         [2]int{30, 45},
		BiologicalEffPct:  [2]int{15, 30},
		ContamRiskNotes:   "Liquid culture critical. Trichoderma is a constant threat in rice substrate.",
		OperatingNotes:    "Light-driven fruiting (12hr photoperiod). Strain dies out - refresh from monoculture every 6 batches.",
	},
}

func init() {
	registry.Register(&registry.Tool{
		Name: "farm.strain_info",
		Description: "Look up the standard cultivation envelope for a strain - typical substrate, " +
			"incubation time, fruiting temp/humidity/CO2/FAE targets, expected biological efficiency, " +
			"contamination risk profile. Use when the user starts a new batch and you want to confirm " +
			"target conditions, or when planning a new room.",
		Schema:   json.RawMessage(SchemaStrainInfo),
		Mutating: false,
		Handler:  handleStrainInfo,
	})
	registry.Register(&registry.Tool{
		Name: "farm.list_strains",
		Description: "List all strains in the built-in catalog (names + aliases). Use when the user " +
			"asks 'what strains do you know about' or to disambiguate a partial name.",
		Schema:   json.RawMessage(`{"type":"object","additionalProperties":false}`),
		Mutating: false,
		Handler:  handleListStrains,
	})
}

const SchemaStrainInfo = `{
  "type": "object",
  "properties": {
    "name": {"type":"string","description":"Strain name or alias (e.g. 'Lions Mane', 'lion's mane', 'hericium')"}
  },
  "required":["name"],
  "additionalProperties":false
}`

type strainInfoArgs struct {
	Name string `json:"name"`
}

func handleStrainInfo(_ context.Context, raw json.RawMessage) (registry.Result, error) {
	var args strainInfoArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return errResult(err), nil
	}
	info := lookupStrain(args.Name)
	if info == nil {
		body, _ := json.Marshal(map[string]any{
			"found":   false,
			"queried": args.Name,
			"hint":    "call farm.list_strains to see the catalog",
		})
		return registry.Result{Content: body}, nil
	}
	body, _ := json.Marshal(map[string]any{
		"found":   true,
		"queried": args.Name,
		"strain":  info,
	})
	return registry.Result{Content: body}, nil
}

func handleListStrains(_ context.Context, _ json.RawMessage) (registry.Result, error) {
	out := make([]map[string]any, 0, len(strainCatalog))
	for _, s := range strainCatalog {
		out = append(out, map[string]any{
			"name":            s.Name,
			"scientific_name": s.ScientificName,
			"aliases":         s.Aliases,
		})
	}
	body, _ := json.Marshal(map[string]any{"strains": out, "count": len(out)})
	return registry.Result{Content: body}, nil
}

// lookupStrain matches by name (case-insensitive) or any alias.
func lookupStrain(query string) *StrainInfo {
	q := strings.ToLower(strings.TrimSpace(query))
	if q == "" {
		return nil
	}
	for i := range strainCatalog {
		s := &strainCatalog[i]
		if strings.EqualFold(s.Name, q) {
			return s
		}
		for _, alias := range s.Aliases {
			if strings.EqualFold(alias, q) {
				return s
			}
		}
	}
	// Partial match fallback: substring on name
	for i := range strainCatalog {
		s := &strainCatalog[i]
		if strings.Contains(strings.ToLower(s.Name), q) {
			return s
		}
	}
	return nil
}
