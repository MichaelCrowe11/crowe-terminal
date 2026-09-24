// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const UpgradeOnboardingModal_v0_15_7_Content = () => {
    return (
        <div className="flex flex-col items-start gap-6 w-full mb-4 unselectable">
            <div className="text-secondary leading-relaxed">
                <p className="mb-0">
                    You are running <strong className="text-foreground">Hypheus 0.15</strong>, the mycelial terminal. A
                    surface of the Crowe Logic platform.
                </p>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-diagram-project"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        Connect CroweLM with your own credential
                    </div>
                    <div className="text-secondary leading-5">
                        Workspace, Code, Deep Work, Grow Ops, and Cultivation Research run on Crowe Logic's model edge
                        with tools. No local model server or Python is required for these modes. In Settings, open
                        Secrets, choose Add New Secret, and save your own model-edge credential as{" "}
                        <span className="font-mono">CROWE_MODELS_KEY</span> before sending a request.
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-leaf"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        Grow Ops and Cultivation Research
                    </div>
                    <div className="text-secondary leading-5">
                        Two cultivation modes carry their domain instructions in the mode itself: contamination triage,
                        fruiting-room conditions, substrate design, and trial plans, with photos.
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-pen-nib"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        The operator panel, in house voice
                    </div>
                    <div className="text-secondary leading-5">
                        Answers set in the Hypheus type scale, tool calls that read as what happened, one quiet state
                        dot, and approvals as a primary and a ghost button.
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-table-columns"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">Dock and startup</div>
                    <div className="text-secondary leading-5">
                        The dock keeps the width you drag to. Launch no longer waits on the Python probe. Windows builds
                        find git and jj again. Releases at{" "}
                        <a target="_blank" href="https://hypheus.com" rel="noopener" className="text-accent">
                            hypheus.com
                        </a>
                        .
                    </div>
                </div>
            </div>
        </div>
    );
};

UpgradeOnboardingModal_v0_15_7_Content.displayName = "UpgradeOnboardingModal_v0_15_7_Content";

export { UpgradeOnboardingModal_v0_15_7_Content };
