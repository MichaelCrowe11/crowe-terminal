// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

package system

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"
	"github.com/shirou/gopsutil/v4/disk"
	"github.com/shirou/gopsutil/v4/host"
	"github.com/shirou/gopsutil/v4/mem"
	"github.com/shirou/gopsutil/v4/net"
	"github.com/shirou/gopsutil/v4/process"
	"github.com/wavetermdev/waveterm/pkg/agent/registry"
)

const SchemaMetrics = `{
  "type": "object",
  "properties": {
    "topn": {"type": "integer", "minimum": 1, "maximum": 50, "default": 5,
             "description": "Number of top processes by CPU to include."}
  },
  "additionalProperties": false
}`

type MetricsArgs struct {
	TopN int `json:"topn"`
}

type ProcInfo struct {
	PID    int32   `json:"pid"`
	Name   string  `json:"name"`
	CPU    float64 `json:"cpu"`
	Mem    float64 `json:"mem_mb"`
	Cmd    string  `json:"cmd,omitempty"`
}

type MetricsSnapshot struct {
	TS         int64      `json:"ts"`
	Hostname   string     `json:"hostname"`
	Platform   string     `json:"platform"`
	UptimeSec  uint64     `json:"uptime_sec"`
	CPUPercent float64    `json:"cpu_percent"`
	CPUPerCore []float64  `json:"cpu_per_core"`
	MemTotalGB float64    `json:"mem_total_gb"`
	MemUsedGB  float64    `json:"mem_used_gb"`
	MemPercent float64    `json:"mem_percent"`
	DiskUsage  []DiskInfo `json:"disk"`
	NetSent    uint64     `json:"net_bytes_sent"`
	NetRecv    uint64     `json:"net_bytes_recv"`
	TopProc    []ProcInfo `json:"top_processes"`
}

type DiskInfo struct {
	Mount      string  `json:"mount"`
	TotalGB    float64 `json:"total_gb"`
	UsedGB     float64 `json:"used_gb"`
	Percent    float64 `json:"percent"`
	FsType     string  `json:"fstype,omitempty"`
}

const bytesPerGB = 1073741824

func init() {
	registry.Register(&registry.Tool{
		Name: "system.metrics",
		Description: "Return a snapshot of host metrics: CPU usage (overall + per core), " +
			"memory, disk, network throughput, top processes by CPU. Read-only.",
		Schema:   json.RawMessage(SchemaMetrics),
		Mutating: false,
		Handler:  handleMetrics,
	})
}

func handleMetrics(ctx context.Context, raw json.RawMessage) (registry.Result, error) {
	var args MetricsArgs
	if len(raw) > 0 {
		if err := json.Unmarshal(raw, &args); err != nil {
			return registry.Result{IsError: true, ErrorText: "invalid arguments: " + err.Error()}, nil
		}
	}
	if args.TopN <= 0 {
		args.TopN = 5
	}
	if args.TopN > 50 {
		args.TopN = 50
	}

	snap := MetricsSnapshot{TS: time.Now().UnixMilli()}
	collect(ctx, &snap, args.TopN)

	body, err := json.Marshal(snap)
	if err != nil {
		return registry.Result{IsError: true, ErrorText: err.Error()}, nil
	}
	return registry.Result{Content: body}, nil
}

func collect(ctx context.Context, snap *MetricsSnapshot, topN int) {
	if info, err := host.InfoWithContext(ctx); err == nil {
		snap.Hostname = info.Hostname
		snap.Platform = info.Platform + " " + info.PlatformVersion
		snap.UptimeSec = info.Uptime
	}
	if pct, err := cpu.PercentWithContext(ctx, 0, false); err == nil && len(pct) > 0 {
		snap.CPUPercent = pct[0]
	}
	if pct, err := cpu.PercentWithContext(ctx, 0, true); err == nil {
		snap.CPUPerCore = pct
	}
	if vm, err := mem.VirtualMemoryWithContext(ctx); err == nil {
		snap.MemTotalGB = float64(vm.Total) / bytesPerGB
		snap.MemUsedGB = float64(vm.Used) / bytesPerGB
		snap.MemPercent = vm.UsedPercent
	}
	if parts, err := disk.PartitionsWithContext(ctx, false); err == nil {
		for _, p := range parts {
			usage, err := disk.UsageWithContext(ctx, p.Mountpoint)
			if err != nil {
				continue
			}
			snap.DiskUsage = append(snap.DiskUsage, DiskInfo{
				Mount:   p.Mountpoint,
				FsType:  p.Fstype,
				TotalGB: float64(usage.Total) / bytesPerGB,
				UsedGB:  float64(usage.Used) / bytesPerGB,
				Percent: usage.UsedPercent,
			})
		}
	}
	if io, err := net.IOCountersWithContext(ctx, false); err == nil && len(io) > 0 {
		snap.NetSent = io[0].BytesSent
		snap.NetRecv = io[0].BytesRecv
	}
	snap.TopProc = topProcesses(ctx, topN)
}

func topProcesses(ctx context.Context, n int) []ProcInfo {
	procs, err := process.ProcessesWithContext(ctx)
	if err != nil {
		return nil
	}
	infos := make([]ProcInfo, 0, len(procs))
	for _, p := range procs {
		cpuPct, _ := p.CPUPercentWithContext(ctx)
		if cpuPct == 0 {
			continue
		}
		name, _ := p.NameWithContext(ctx)
		mi, _ := p.MemoryInfoWithContext(ctx)
		var memMB float64
		if mi != nil {
			memMB = float64(mi.RSS) / 1024 / 1024
		}
		infos = append(infos, ProcInfo{
			PID:  p.Pid,
			Name: name,
			CPU:  cpuPct,
			Mem:  memMB,
		})
	}
	sort.Slice(infos, func(i, j int) bool { return infos[i].CPU > infos[j].CPU })
	if len(infos) > n {
		infos = infos[:n]
	}
	return infos
}
