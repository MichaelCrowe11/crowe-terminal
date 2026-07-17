// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const UpgradeOnboardingModal_v0_14_11_Content = () => {
    return (
        <div className="flex flex-col items-start gap-6 w-full mb-4 unselectable">
            <div className="text-secondary leading-relaxed">
                <p className="mb-0">
                    You are running <strong className="text-foreground">Hypheus</strong>, the mycelial
                    terminal. A surface of the Crowe Logic platform.
                </p>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-code"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        One root, many panes
                    </div>
                    <div className="text-secondary leading-5">
                        Your shell, a browser, your files, and an operator panel grow from one root and stay
                        connected, so context travels with you instead of scattering across windows.
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-circle-info"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        Open and yours
                    </div>
                    <div className="text-secondary leading-5">
                        Hypheus is open source, built on Wave. Follow releases and docs at{" "}
                        <a
                            target="_blank"
                            href="https://hypheus.com"
                            rel="noopener"
                            className="text-accent"
                        >
                            hypheus.com
                        </a>
                        .
                    </div>
                </div>
            </div>
        </div>
    );
};

UpgradeOnboardingModal_v0_14_11_Content.displayName = "UpgradeOnboardingModal_v0_14_11_Content";

export { UpgradeOnboardingModal_v0_14_11_Content };
