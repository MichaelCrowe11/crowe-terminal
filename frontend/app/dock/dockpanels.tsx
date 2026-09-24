// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { isCroweAccountMode } from "@/app/aipanel/croweaccount-model";
import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { atoms } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { DesignAnnotation, DesignReviewModel, DesignSeverity } from "./designreview-model";
import { DockModel } from "./dock-model";
import { TelemetryModel } from "./telemetry-model";
import { VcsModel } from "./vcs-model";

function fmtMs(ms: number): string {
    if (!ms) {
        return "--";
    }
    if (ms < 1000) {
        return `${Math.round(ms)} ms`;
    }
    return `${(ms / 1000).toFixed(1)} s`;
}

// --- Telemetry -------------------------------------------------------------

const Sparkline = ({ data }: { data: number[] }) => {
    if (data.length < 2) {
        return <div className="crowe-spark crowe-spark-empty" />;
    }
    const max = Math.max(...data, 1);
    const w = 100;
    const h = 30;
    const step = w / (data.length - 1);
    const points = data.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`).join(" ");
    return (
        <svg className="crowe-spark" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none">
            <polyline points={points} fill="none" />
        </svg>
    );
};

export function activityLabel(status: string, phase: string, tool: string): string {
    if (status === "error") return "Run ended with an error";
    if (status === "done") return "Run complete";
    if (status !== "running") return "No active run";
    if (phase === "tool") return tool ? `Tool event: ${tool}` : "Tool event received";
    if (phase === "reasoning") return "Receiving reasoning output";
    if (phase === "responding") return "Receiving response";
    return "Waiting for response";
}

export function endpointDisplay(value: string): { origin: string; location: string } {
    if (!value?.trim()) return { origin: "Not specified", location: "Unknown endpoint" };
    try {
        const url = new URL(value);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error();
        const loopback = url.hostname === "localhost" || url.hostname === "[::1]" || /^127\./.test(url.hostname);
        return { origin: url.origin, location: loopback ? "Loopback endpoint" : "Remote endpoint" };
    } catch {
        return { origin: "Invalid endpoint", location: "Unknown endpoint" };
    }
}

export const TelemetryPanel = () => {
    const t = TelemetryModel.getInstance();
    const status = useAtomValue(t.statusAtom);
    const phase = useAtomValue(t.phaseAtom);
    const tps = useAtomValue(t.tokensPerSecAtom);
    const ttft = useAtomValue(t.ttftMsAtom);
    const tokens = useAtomValue(t.tokensAtom);
    const reasoningTokens = useAtomValue(t.reasoningTokensAtom);
    const toolCount = useAtomValue(t.toolCountAtom);
    const currentTool = useAtomValue(t.currentToolAtom);
    const elapsed = useAtomValue(t.elapsedMsAtom);
    const history = useAtomValue(t.historyAtom);
    const hasRun = useAtomValue(t.hasRunAtom);
    const live = useAtomValue(t.liveAtom);

    const statusLabel = activityLabel(status, phase, currentTool);

    return (
        <div className="crowe-panel">
            <div className={cn("crowe-status-line", `crowe-status-${status}`)}>
                <span className="crowe-status-dot" />
                <span>{statusLabel}</span>
                <span className="crowe-status-src" title="Connection status is separate from estimated token counts.">
                    {live ? "Event stream connected" : "Message stream fallback"}
                </span>
            </div>
            <div className="crowe-metrics">
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{tps > 0 ? tps.toFixed(1) : "--"}</span>
                    <span className="crowe-metric-lbl">tok/s est</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{fmtMs(ttft)}</span>
                    <span className="crowe-metric-lbl">TTFT</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{tokens > 0 ? tokens : "--"}</span>
                    <span className="crowe-metric-lbl">answer tok est</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{reasoningTokens > 0 ? reasoningTokens : "--"}</span>
                    <span className="crowe-metric-lbl">reasoning tok est</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{toolCount > 0 ? toolCount : "--"}</span>
                    <span className="crowe-metric-lbl">tool calls</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{fmtMs(elapsed)}</span>
                    <span className="crowe-metric-lbl">elapsed at last event</span>
                </div>
            </div>
            <div className="crowe-panel-hint">
                Token counts and throughput are estimated from output characters, not provider usage.
            </div>
            <Sparkline data={history} />
            {!hasRun && (
                <div className="crowe-empty">Send a message in the operator panel to see live inference telemetry.</div>
            )}
        </div>
    );
};

// --- Model picker ----------------------------------------------------------

export const ModelPanel = () => {
    const model = WaveAIModel.getInstance();
    const configs = useAtomValue(model.aiModeConfigs);
    const current = useAtomValue(model.currentAIMode);

    const entries = Object.entries(configs ?? {}).sort(
        (a, b) => (a[1]["display:order"] ?? 0) - (b[1]["display:order"] ?? 0)
    );

    if (entries.length === 0) {
        return <div className="crowe-empty">No engines configured.</div>;
    }

    return (
        <div className="crowe-panel">
            <div className="crowe-panel-hint">
                Choose an engine for this tab. Your chat and draft stay in place. Nothing sends until you submit.
            </div>
            <button
                type="button"
                onClick={() => model.openCroweAccount()}
                className="crowe-account-alternative cursor-pointer"
            >
                Open Crowe account
            </button>
            <div className="crowe-model-list">
                {entries.map(([key, cfg]) => {
                    const active = key === current;
                    const cloud = cfg["waveai:cloud"];
                    const accountMode = isCroweAccountMode(key, cfg);
                    const endpoint = endpointDisplay(cfg["ai:endpoint"]);
                    const proxy = cfg["ai:proxyurl"] ? endpointDisplay(cfg["ai:proxyurl"]) : null;
                    return (
                        <button
                            key={key}
                            type="button"
                            className={cn("crowe-model-item cursor-pointer", active && "crowe-model-item-active")}
                            onClick={() => {
                                model.setAIMode(key);
                                DockModel.getInstance().collapse();
                                setTimeout(() => model.focusInput(), 0);
                            }}
                            aria-pressed={active}
                        >
                            <div className="crowe-model-row">
                                <span className="crowe-model-name">{cfg["display:name"] ?? key}</span>
                                {active && <i className="fa fa-solid fa-check crowe-model-check" />}
                            </div>
                            {cfg["display:description"] && (
                                <div className="crowe-model-desc">{cfg["display:description"]}</div>
                            )}
                            <div className="crowe-model-meta">
                                <span>
                                    {accountMode ? "Crowe account sign-in" : cloud ? "Managed route" : "Advanced setup"}
                                </span>
                                <span>Engine: {cfg["ai:model"] || "Not specified"}</span>
                                {cfg["ai:provider"] && <span>Provider: {cfg["ai:provider"]}</span>}
                                <span>
                                    {endpoint.location}: {endpoint.origin}
                                </span>
                                {proxy && <span>Proxy origin: {proxy.origin}</span>}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

// --- Thinking indicator ----------------------------------------------------

export const ThinkingPanel = () => {
    const t = TelemetryModel.getInstance();
    const status = useAtomValue(t.statusAtom);
    const phase = useAtomValue(t.phaseAtom);
    const currentTool = useAtomValue(t.currentToolAtom);
    const elapsed = useAtomValue(t.elapsedMsAtom);
    const hasRun = useAtomValue(t.hasRunAtom);

    return (
        <div className="crowe-panel crowe-activity">
            <div role="status" aria-live="polite" className={cn("crowe-status-line", `crowe-status-${status}`)}>
                <span className="crowe-status-dot" aria-hidden="true" />
                <span>{activityLabel(status, phase, currentTool)}</span>
            </div>
            {hasRun && <div className="crowe-think-timer">Elapsed at last event: {fmtMs(elapsed)}</div>}
            <div className="crowe-panel-hint">
                Activity reflects received output and tool events, not internal cognition.
            </div>
        </div>
    );
};

// --- Design review ---------------------------------------------------------

const DesignRow = ({ ann }: { ann: DesignAnnotation }) => {
    const dr = DesignReviewModel.getInstance();
    return (
        <div
            className={cn(
                "crowe-note",
                `crowe-note-${ann.severity}`,
                ann.status === "resolved" && "crowe-note-resolved"
            )}
        >
            <div className="crowe-note-head">
                <span className={cn("crowe-sev", `crowe-sev-${ann.severity}`)}>{ann.severity}</span>
                <span className="crowe-note-target">{ann.target}</span>
            </div>
            <div className="crowe-note-body">{ann.note}</div>
            <div className="crowe-note-actions">
                {ann.status === "open" ? (
                    <button
                        type="button"
                        className="crowe-link cursor-pointer"
                        onClick={() => dr.setStatus(ann.id, "resolved")}
                    >
                        resolve
                    </button>
                ) : (
                    <button
                        type="button"
                        className="crowe-link cursor-pointer"
                        onClick={() => dr.setStatus(ann.id, "open")}
                    >
                        reopen
                    </button>
                )}
                <button
                    type="button"
                    className="crowe-link crowe-link-danger cursor-pointer"
                    onClick={() => dr.remove(ann.id)}
                >
                    delete
                </button>
            </div>
        </div>
    );
};

export const DesignPanel = () => {
    const dr = DesignReviewModel.getInstance();
    const annotations = useAtomValue(dr.annotationsAtom);
    const [target, setTarget] = useState("");
    const [severity, setSeverity] = useState<DesignSeverity>("polish");
    const [note, setNote] = useState("");

    const submit = () => {
        if (!note.trim()) {
            return;
        }
        dr.add(target, severity, note);
        setTarget("");
        setNote("");
        setSeverity("polish");
    };

    const open = annotations.filter((a) => a.status === "open");
    const resolved = annotations.filter((a) => a.status === "resolved");

    return (
        <div className="crowe-panel">
            <div className="crowe-form">
                <input
                    className="crowe-input"
                    placeholder="Target (e.g. tab bar, block header)"
                    value={target}
                    onChange={(e) => setTarget(e.target.value)}
                />
                <select
                    className="crowe-input"
                    value={severity}
                    onChange={(e) => setSeverity(e.target.value as DesignSeverity)}
                >
                    <option value="polish">polish</option>
                    <option value="usability">usability</option>
                    <option value="blocker">blocker</option>
                </select>
                <textarea
                    className="crowe-input crowe-textarea"
                    placeholder="What needs work?"
                    value={note}
                    onChange={(e) => setNote(e.target.value)}
                />
                <button type="button" className="crowe-btn cursor-pointer" onClick={submit}>
                    Add note
                </button>
            </div>
            {open.length === 0 && resolved.length === 0 && (
                <div className="crowe-empty">
                    No design notes yet. Capture polish items, usability snags, and blockers here.
                </div>
            )}
            {open.map((a) => (
                <DesignRow key={a.id} ann={a} />
            ))}
            {resolved.length > 0 && <div className="crowe-panel-hint">Resolved</div>}
            {resolved.map((a) => (
                <DesignRow key={a.id} ann={a} />
            ))}
        </div>
    );
};

// --- Mycelium (live workspace graph) --------------------------------------

const MyceliumNode = ({ blockId, angle, radius }: { blockId: string; angle: number; radius: number }) => {
    const block = useAtomValue(WOS.getWaveObjectAtom(WOS.makeORef("block", blockId))) as Block;
    const view = block?.meta?.view ?? "block";
    const x = 50 + Math.cos(angle) * radius;
    const y = 50 + Math.sin(angle) * radius;
    return (
        <>
            <line className="crowe-edge" x1="50" y1="50" x2={x} y2={y} />
            <circle className="crowe-node" cx={x} cy={y} r="4.5" />
            <text className="crowe-node-label" x={x} y={y - 7} textAnchor="middle">
                {view}
            </text>
        </>
    );
};

export const MyceliumPanel = () => {
    const tabId = useAtomValue(atoms.staticTabId);
    const tab = useAtomValue(WOS.getWaveObjectAtom(WOS.makeORef("tab", tabId))) as Tab;
    const blockIds = tab?.blockids ?? [];

    return (
        <div className="crowe-panel">
            <div className="crowe-panel-hint">Live workspace graph: one node per block in this tab.</div>
            {blockIds.length === 0 ? (
                <div className="crowe-empty">No blocks in this tab yet.</div>
            ) : (
                <svg className="crowe-graph" viewBox="0 0 100 100">
                    <circle className="crowe-node crowe-node-center" cx="50" cy="50" r="6" />
                    <text className="crowe-node-label" x="50" y="41" textAnchor="middle">
                        tab
                    </text>
                    {blockIds.map((id, i) => (
                        <MyceliumNode
                            key={id}
                            blockId={id}
                            angle={(i / blockIds.length) * Math.PI * 2 - Math.PI / 2}
                            radius={34}
                        />
                    ))}
                </svg>
            )}
            <div className="crowe-graph-count">
                {blockIds.length} node{blockIds.length === 1 ? "" : "s"}
            </div>
        </div>
    );
};

// --- Repository (jj operation log) -----------------------------------------

const VcsFileRow = ({ file }: { file: VcsFileChange }) => (
    <div className="crowe-vcs-file">
        <span className="crowe-vcs-file-path" title={file.path}>
            {file.path}
        </span>
        <span className="crowe-vcs-counts">
            {file.plus > 0 && <span className="crowe-vcs-plus">+{file.plus}</span>}
            {file.minus > 0 && <span className="crowe-vcs-minus">-{file.minus}</span>}
            {file.plus === 0 && file.minus === 0 && <span>{file.changes}</span>}
        </span>
    </div>
);

const VcsOpRow = ({ op }: { op: VcsOperation }) => {
    const m = VcsModel.getInstance();
    const expandedOp = useAtomValue(m.expandedOpAtom);
    const opFiles = useAtomValue(m.opFilesAtom);
    const busy = useAtomValue(m.busyAtom);
    const expanded = expandedOp === op.opid;
    const files = opFiles[op.opid];
    return (
        <div className={cn("crowe-vcs-op", expanded && "crowe-vcs-op-expanded")}>
            <button
                type="button"
                className="crowe-vcs-op-head cursor-pointer"
                onClick={() => m.toggleOp(op.opid)}
                aria-expanded={expanded}
            >
                <span className="crowe-vcs-op-desc" title={op.description}>
                    {op.description || "(no description)"}
                </span>
                <span className="crowe-vcs-op-time">{op.timerel}</span>
            </button>
            {expanded && (
                <div className="crowe-vcs-op-body">
                    {files == null && <div className="crowe-panel-hint">Reading files</div>}
                    {files != null && files.length === 0 && (
                        <div className="crowe-panel-hint">No file changes in this operation.</div>
                    )}
                    {files?.map((f) => (
                        <VcsFileRow key={f.path} file={f} />
                    ))}
                    <button
                        type="button"
                        className="crowe-btn cursor-pointer"
                        disabled={busy}
                        onClick={() => m.restoreTo(op.opid)}
                    >
                        Restore to here
                    </button>
                </div>
            )}
        </div>
    );
};

export const VcsPanel = () => {
    const m = VcsModel.getInstance();
    const status = useAtomValue(m.statusAtom);
    const history = useAtomValue(m.historyAtom);
    const busy = useAtomValue(m.busyAtom);
    const error = useAtomValue(m.errorAtom);

    useEffect(() => {
        m.refresh(true);
    }, []);

    if (status == null) {
        return <div className="crowe-empty">Reading repository state.</div>;
    }
    if (!status.installed) {
        return (
            <div className="crowe-panel">
                <div className="crowe-empty">Jujutsu (jj) is not installed, so there is no operation log to show.</div>
            </div>
        );
    }
    if (!status.isrepo) {
        return (
            <div className="crowe-panel">
                <div className="crowe-vcs-dir" title={status.dir}>
                    {status.dir}
                </div>
                <div className="crowe-empty">This directory is not tracked yet.</div>
                <button type="button" className="crowe-btn cursor-pointer" disabled={busy} onClick={() => m.initRepo()}>
                    Start tracking this directory
                </button>
                <div className="crowe-panel-hint">
                    Creates a self-contained local repository with no remote. Nothing is sent anywhere.
                </div>
            </div>
        );
    }
    const fileCount = status.files?.length ?? 0;
    return (
        <div className="crowe-panel">
            <div className="crowe-vcs-dir" title={status.root || status.dir}>
                {status.root || status.dir}
            </div>
            {error && <div className="crowe-vcs-error">{error}</div>}
            <div className={cn("crowe-vcs-now", !status.clean && "crowe-vcs-now-dirty")}>
                <div className="crowe-vcs-now-head">
                    <span className="crowe-vcs-now-label">Now</span>
                    <span className="crowe-vcs-now-summary">
                        {status.clean
                            ? "no uncommitted changes"
                            : `${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
                    </span>
                    {!status.clean && (
                        <button
                            type="button"
                            className="crowe-link cursor-pointer"
                            disabled={busy}
                            onClick={() => m.restoreTo()}
                            title="Reverses only the most recent operation. Use a row below to restore further back."
                        >
                            undo last op
                        </button>
                    )}
                </div>
                {status.files?.map((f) => (
                    <VcsFileRow key={f.path} file={f} />
                ))}
            </div>
            {history.length === 0 ? (
                <div className="crowe-empty">No operations recorded yet.</div>
            ) : (
                history.map((op) => <VcsOpRow key={op.opid} op={op} />)
            )}
            <div className="crowe-panel-hint">
                Every restore is itself an operation, so a restore can always be restored.
            </div>
        </div>
    );
};
