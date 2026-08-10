// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { WaveAIModel } from "@/app/aipanel/waveai-model";
import { atoms } from "@/app/store/global";
import * as WOS from "@/app/store/wos";
import { cn } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect, useState } from "react";
import { DesignAnnotation, DesignReviewModel, DesignSeverity } from "./designreview-model";
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

const PhaseLabels: Record<string, string> = {
    idle: "idle",
    reasoning: "reasoning",
    responding: "responding",
    tool: "tool call",
};

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

    const statusLabel =
        status === "running" ? (phase !== "idle" ? PhaseLabels[phase] : "generating") : status;

    return (
        <div className="crowe-panel">
            <div className={cn("crowe-status-line", `crowe-status-${status}`)}>
                <span className="crowe-status-dot" />
                <span>{statusLabel}</span>
                <span className="crowe-status-src" title={live ? "Live foundry event stream" : "Estimated from message stream"}>
                    {live ? "live" : "est"}
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
                    <span className="crowe-metric-lbl">answer tok</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{reasoningTokens > 0 ? reasoningTokens : "--"}</span>
                    <span className="crowe-metric-lbl">reasoning tok</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{toolCount > 0 ? toolCount : "--"}</span>
                    <span className="crowe-metric-lbl">tool calls</span>
                </div>
                <div className="crowe-metric">
                    <span className="crowe-metric-val">{fmtMs(elapsed)}</span>
                    <span className="crowe-metric-lbl">elapsed</span>
                </div>
            </div>
            {currentTool && (
                <div className="crowe-status-line">
                    <span>running</span>
                    <span className="crowe-note-target">{currentTool}</span>
                </div>
            )}
            <Sparkline data={history} />
            {!hasRun && (
                <div className="crowe-empty">Send a message in the AI panel to see live inference telemetry.</div>
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
        return <div className="crowe-empty">No AI modes configured.</div>;
    }

    return (
        <div className="crowe-panel">
            <div className="crowe-panel-hint">The model the AI panel routes to. Changes apply to the next message.</div>
            <div className="crowe-model-list">
                {entries.map(([key, cfg]) => {
                    const active = key === current;
                    const cloud = cfg["waveai:cloud"];
                    return (
                        <button
                            key={key}
                            type="button"
                            className={cn("crowe-model-item cursor-pointer", active && "crowe-model-item-active")}
                            onClick={() => model.setAIMode(key)}
                        >
                            <div className="crowe-model-row">
                                <span className="crowe-model-name">{cfg["display:name"] ?? key}</span>
                                {active && <i className="fa fa-solid fa-check crowe-model-check" />}
                            </div>
                            {cfg["display:description"] && (
                                <div className="crowe-model-desc">{cfg["display:description"]}</div>
                            )}
                            <div className="crowe-model-meta">
                                <span>{cloud ? "cloud" : "local"}</span>
                                {cfg["ai:model"] && <span>{cfg["ai:model"]}</span>}
                                {cfg["ai:provider"] && <span>{cfg["ai:provider"]}</span>}
                            </div>
                        </button>
                    );
                })}
            </div>
        </div>
    );
};

// --- Thinking indicator ----------------------------------------------------

const CognitionVerbs = ["Germinating", "Branching", "Colonizing", "Synthesizing", "Reasoning", "Cultivating"];

export const ThinkingPanel = () => {
    const model = WaveAIModel.getInstance();
    const t = TelemetryModel.getInstance();
    const streaming = useAtomValue(model.isAIStreaming);
    const phase = useAtomValue(t.phaseAtom);
    const currentTool = useAtomValue(t.currentToolAtom);
    const elapsed = useAtomValue(t.elapsedMsAtom);
    const [verbIdx, setVerbIdx] = useState(0);

    useEffect(() => {
        if (!streaming) {
            return;
        }
        const id = setInterval(() => setVerbIdx((i) => (i + 1) % CognitionVerbs.length), 1400);
        return () => clearInterval(id);
    }, [streaming]);

    if (!streaming) {
        return (
            <div className="crowe-panel crowe-think crowe-think-idle">
                <div className="crowe-think-glyph" />
                <div className="crowe-empty">
                    The model is idle. Ask something in the AI panel and this shows live cognition.
                </div>
            </div>
        );
    }

    let verb = CognitionVerbs[verbIdx];
    if (phase === "tool" && currentTool) {
        verb = `Running ${currentTool}`;
    } else if (phase === "reasoning") {
        verb = "Reasoning";
    } else if (phase === "responding") {
        verb = "Responding";
    }

    return (
        <div className="crowe-panel crowe-think">
            <div className="crowe-think-glyph crowe-think-glyph-live" />
            <div className="crowe-think-verb">
                {verb}
                <span className="crowe-think-dots">
                    <span>.</span>
                    <span>.</span>
                    <span>.</span>
                </span>
            </div>
            <div className="crowe-think-timer">{(elapsed / 1000).toFixed(1)}s</div>
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
            <div className="crowe-panel-hint">Live workspace graph — one node per block in this tab.</div>
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
                        {status.clean ? "no uncommitted changes" : `${fileCount} file${fileCount === 1 ? "" : "s"} changed`}
                    </span>
                    {!status.clean && (
                        <button
                            type="button"
                            className="crowe-link cursor-pointer"
                            disabled={busy}
                            onClick={() => m.restoreTo()}
                        >
                            undo last
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
            <div className="crowe-panel-hint">Every restore is itself an operation, so a restore can always be restored.</div>
        </div>
    );
};
