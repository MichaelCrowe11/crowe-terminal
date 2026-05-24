// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { BlockNodeModel } from "@/app/block/blocktypes";
import { loadMonaco } from "@/app/monaco/monaco-env";
import { WOS } from "@/app/store/global";
import { globalStore } from "@/app/store/jotaiStore";
import type { TabModel } from "@/app/store/tab-model";
import { WaveEnv } from "@/app/waveenv/waveenv";
import { fireAndForget } from "@/util/util";
import * as jotai from "jotai";
import * as monaco from "monaco-editor";
import { CroweCodeWorkspaceModel } from "../crowecode-workspace-model";
import { CroweCodeProblemsView } from "./crowecode-problems";

export type ProblemEntry = {
    resource: string;
    severity: monaco.MarkerSeverity;
    severityLabel: "error" | "warning" | "info" | "hint";
    message: string;
    startLine: number;
    startColumn: number;
    source?: string;
};

function severityLabel(s: monaco.MarkerSeverity): ProblemEntry["severityLabel"] {
    if (s === monaco.MarkerSeverity.Error) return "error";
    if (s === monaco.MarkerSeverity.Warning) return "warning";
    if (s === monaco.MarkerSeverity.Info) return "info";
    return "hint";
}

export class CroweCodeProblemsViewModel implements ViewModel {
    viewType: string;
    blockId: string;
    nodeModel: BlockNodeModel;
    blockAtom: jotai.Atom<Block>;
    env: WaveEnv;

    viewIcon = jotai.atom<string>("circle-exclamation");
    viewName = jotai.atom<string>("Problems");
    noPadding = jotai.atom<boolean>(true);

    problemsAtom: jotai.PrimitiveAtom<ProblemEntry[]>;
    workspaceModel: CroweCodeWorkspaceModel;
    private markersDisposable: monaco.IDisposable | null = null;

    constructor({
        blockId,
        nodeModel,
        waveEnv,
    }: {
        blockId: string;
        nodeModel: BlockNodeModel;
        tabModel: TabModel;
        waveEnv: WaveEnv;
    }) {
        this.viewType = "crowecode-problems";
        this.blockId = blockId;
        this.nodeModel = nodeModel;
        this.blockAtom = WOS.getWaveObjectAtom<Block>(`block:${blockId}`);
        this.env = waveEnv;
        this.workspaceModel = CroweCodeWorkspaceModel.getInstance();
        this.problemsAtom = jotai.atom<ProblemEntry[]>([]);
        fireAndForget(this.subscribe.bind(this));
    }

    get viewComponent(): ViewComponent {
        return CroweCodeProblemsView;
    }

    private async subscribe(): Promise<void> {
        await loadMonaco();
        this.refreshFromMonaco();
        // onDidChangeMarkers fires whenever the marker service updates;
        // listener takes a list of resource URIs that changed, but we just
        // re-pull the full snapshot — the model count is small (one per
        // open editor block) and the API is cheap.
        this.markersDisposable = monaco.editor.onDidChangeMarkers(() => {
            this.refreshFromMonaco();
        });
    }

    private refreshFromMonaco(): void {
        const all = monaco.editor.getModelMarkers({});
        const entries: ProblemEntry[] = all.map((m) => ({
            resource: m.resource.toString(),
            severity: m.severity,
            severityLabel: severityLabel(m.severity),
            message: m.message,
            startLine: m.startLineNumber,
            startColumn: m.startColumn,
            source: m.source,
        }));
        // sort by severity (errors first), then by resource + line
        entries.sort((a, b) => {
            if (a.severity !== b.severity) return b.severity - a.severity;
            if (a.resource !== b.resource) return a.resource.localeCompare(b.resource);
            return a.startLine - b.startLine;
        });
        globalStore.set(this.problemsAtom, entries);
    }

    // Open the file referenced by a problem entry. Resource URIs from
    // monaco-vscode-api are file:// scheme; strip to a plain path before
    // handing to the editor block's crowecode:file meta.
    async openProblem(entry: ProblemEntry): Promise<void> {
        const uri = monaco.Uri.parse(entry.resource);
        const filePath = uri.scheme === "file" ? uri.fsPath : uri.path;
        if (!filePath) return;
        const workspace = this.workspaceModel.getWorkspaceFolder();
        const blockDef: BlockDef = {
            meta: {
                view: "crowecode",
                "crowecode:file": filePath,
                ...(workspace ? { "crowecode:workspace": workspace } : {}),
            } as MetaType,
        };
        await this.env.createBlock(blockDef, false, false);
    }

    dispose(): void {
        this.markersDisposable?.dispose();
        this.markersDisposable = null;
    }

    keyDownHandler(): boolean {
        return false;
    }

    giveFocus(): boolean {
        return false;
    }
}
