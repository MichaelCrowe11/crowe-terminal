// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { globalStore } from "@/app/store/jotaiStore";
import * as jotai from "jotai";

export type TelemetryStatus = "idle" | "running" | "done" | "error";
export type TelemetryPhase = "idle" | "reasoning" | "responding" | "tool";

const HistoryLen = 48;
// The side-channel gives real reasoning/answer/tool events but not token
// counts, so tokens are estimated from characters (~4 chars/token for English
// + code). The UI labels this as an estimate; nothing here is fabricated.
const CharsPerToken = 4;
// Matches BRIDGE_PORT in emain/emain-foundry-bridge.ts.
const TelemetryStreamUrl = "http://127.0.0.1:8011/crowe/telemetry/stream";

export class TelemetryModel {
    private static instance: TelemetryModel | null = null;

    statusAtom: jotai.PrimitiveAtom<TelemetryStatus> = jotai.atom("idle") as jotai.PrimitiveAtom<TelemetryStatus>;
    phaseAtom: jotai.PrimitiveAtom<TelemetryPhase> = jotai.atom("idle") as jotai.PrimitiveAtom<TelemetryPhase>;
    ttftMsAtom: jotai.PrimitiveAtom<number> = jotai.atom(0);
    tokensPerSecAtom: jotai.PrimitiveAtom<number> = jotai.atom(0);
    tokensAtom: jotai.PrimitiveAtom<number> = jotai.atom(0);
    reasoningTokensAtom: jotai.PrimitiveAtom<number> = jotai.atom(0);
    toolCountAtom: jotai.PrimitiveAtom<number> = jotai.atom(0);
    currentToolAtom: jotai.PrimitiveAtom<string> = jotai.atom("") as jotai.PrimitiveAtom<string>;
    elapsedMsAtom: jotai.PrimitiveAtom<number> = jotai.atom(0);
    historyAtom: jotai.PrimitiveAtom<number[]> = jotai.atom([]) as jotai.PrimitiveAtom<number[]>;
    hasRunAtom: jotai.PrimitiveAtom<boolean> = jotai.atom(false);
    // True once the bridge telemetry side-channel is connected; when set, its
    // events own answer accounting so the aipanel char fallback stands down.
    liveAtom: jotai.PrimitiveAtom<boolean> = jotai.atom(false);

    // Timing/accounting scratch — public so state stays inspectable (repo rule: no private fields).
    startTs = 0;
    firstTokenTs = 0;
    answerChars = 0;
    reasoningChars = 0;
    sawLiveToken = false;
    source: EventSource = null;

    static getInstance(): TelemetryModel {
        if (!TelemetryModel.instance) {
            TelemetryModel.instance = new TelemetryModel();
        }
        return TelemetryModel.instance;
    }

    connect() {
        if (this.source != null || typeof EventSource === "undefined") {
            return;
        }
        try {
            const es = new EventSource(TelemetryStreamUrl);
            this.source = es;
            es.onopen = () => globalStore.set(this.liveAtom, true);
            es.onerror = () => globalStore.set(this.liveAtom, false);
            es.onmessage = (e) => this.onStreamEvent(e.data);
        } catch {
            this.source = null;
        }
    }

    onStreamEvent(data: string) {
        let event: any;
        try {
            event = JSON.parse(data);
        } catch {
            return;
        }
        const t = event?.type;
        if (t === "ready") {
            globalStore.set(this.liveAtom, true);
            return;
        }
        if (t === "reasoning") {
            this.liveReasoning(event.chars ?? 0);
            return;
        }
        if (t === "token") {
            this.liveToken(event.chars ?? 0);
            return;
        }
        if (t === "tool") {
            this.liveTool(event.name ?? "");
            return;
        }
        if (t === "run_end") {
            this.finish(!!event.errored);
        }
    }

    onSubmit() {
        this.startTs = performance.now();
        this.firstTokenTs = 0;
        this.answerChars = 0;
        this.reasoningChars = 0;
        this.sawLiveToken = false;
        globalStore.set(this.statusAtom, "running");
        globalStore.set(this.phaseAtom, "reasoning");
        globalStore.set(this.ttftMsAtom, 0);
        globalStore.set(this.tokensPerSecAtom, 0);
        globalStore.set(this.tokensAtom, 0);
        globalStore.set(this.reasoningTokensAtom, 0);
        globalStore.set(this.toolCountAtom, 0);
        globalStore.set(this.currentToolAtom, "");
        globalStore.set(this.elapsedMsAtom, 0);
        globalStore.set(this.historyAtom, []);
        globalStore.set(this.hasRunAtom, true);
    }

    markFirstToken(now: number) {
        if (this.firstTokenTs !== 0) {
            return;
        }
        this.firstTokenTs = now;
        globalStore.set(this.ttftMsAtom, Math.round(now - this.startTs));
    }

    liveReasoning(chars: number) {
        if (this.startTs === 0) {
            return;
        }
        this.reasoningChars += chars;
        globalStore.set(this.phaseAtom, "reasoning");
        globalStore.set(this.reasoningTokensAtom, Math.round(this.reasoningChars / CharsPerToken));
        globalStore.set(this.elapsedMsAtom, Math.round(performance.now() - this.startTs));
    }

    liveToken(chars: number) {
        if (this.startTs === 0) {
            return;
        }
        this.sawLiveToken = true;
        const now = performance.now();
        this.markFirstToken(now);
        this.answerChars += chars;
        globalStore.set(this.phaseAtom, "responding");
        this.commitRate(now, this.answerChars);
    }

    liveTool(name: string) {
        if (this.startTs === 0) {
            return;
        }
        globalStore.set(this.phaseAtom, "tool");
        globalStore.set(this.currentToolAtom, name);
        globalStore.set(this.toolCountAtom, globalStore.get(this.toolCountAtom) + 1);
    }

    // Fallback answer accounting from the aipanel message stream. Stands down
    // when the side-channel is delivering real token events this run.
    recordChars(totalChars: number) {
        if (this.startTs === 0 || this.sawLiveToken) {
            return;
        }
        const now = performance.now();
        if (totalChars > 0) {
            this.markFirstToken(now);
            globalStore.set(this.phaseAtom, "responding");
        }
        this.commitRate(now, totalChars);
    }

    commitRate(now: number, answerChars: number) {
        const tokens = Math.round(answerChars / CharsPerToken);
        globalStore.set(this.tokensAtom, tokens);
        const genMs = this.firstTokenTs > 0 ? now - this.firstTokenTs : 0;
        const tps = genMs > 200 ? (tokens / genMs) * 1000 : 0;
        globalStore.set(this.tokensPerSecAtom, tps);
        globalStore.set(this.elapsedMsAtom, Math.round(now - this.startTs));
        const hist = globalStore.get(this.historyAtom);
        globalStore.set(this.historyAtom, [...hist, tps].slice(-HistoryLen));
    }

    finish(errored: boolean) {
        if (this.startTs === 0) {
            return;
        }
        globalStore.set(this.statusAtom, errored ? "error" : "done");
        globalStore.set(this.phaseAtom, "idle");
        globalStore.set(this.currentToolAtom, "");
        globalStore.set(this.elapsedMsAtom, Math.round(performance.now() - this.startTs));
        this.startTs = 0;
    }
}
