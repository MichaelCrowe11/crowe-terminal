// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

import { VcsPanel } from "@/app/dock/dockpanels";
import { VcsModel } from "@/app/dock/vcs-model";
import { globalStore } from "@/app/store/jotaiStore";

VcsModel.fetchDisabled = true;
const model = VcsModel.getInstance();
globalStore.set(model.statusAtom, {
    installed: true,
    isrepo: true,
    dir: "/Users/mike/Projects/hypheus",
    root: "/Users/mike/Projects/hypheus",
    clean: false,
    files: [
        { path: "frontend/app/dock/utilitydock.tsx", changes: 12, plus: 9, minus: 3 },
        { path: "pkg/jj/jj.go", changes: 4, plus: 4, minus: 0 },
    ],
});
globalStore.set(model.historyAtom, [
    { opid: "f0302bfacf0f", description: "snapshot working copy", time: "2026-08-09 07:05:33", timerel: "2 minutes ago" },
    { opid: "902af479a0b1", description: "snapshot working copy", time: "2026-08-09 06:51:10", timerel: "16 minutes ago" },
    { opid: "8c1d22aa90ef", description: "restore to operation 44f1", time: "2026-08-09 06:40:02", timerel: "27 minutes ago" },
    { opid: "44f19c0be2d1", description: "snapshot working copy", time: "2026-08-09 06:12:44", timerel: "55 minutes ago" },
]);
globalStore.set(model.opFilesAtom, {
    "902af479a0b1": [{ path: "frontend/app/dock/dock.scss", changes: 6, plus: 5, minus: 1 }],
});
globalStore.set(model.expandedOpAtom, "902af479a0b1");

export default function VcsPreview() {
    return (
        <div className="flex h-[640px] w-[360px] flex-col overflow-y-auto border border-border bg-background p-3 shadow-xl">
            <VcsPanel />
        </div>
    );
}
