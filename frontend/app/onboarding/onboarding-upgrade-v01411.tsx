// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const UpgradeOnboardingModal_v0_14_11_Content = () => {
    return (
        <div className="flex flex-col items-start gap-6 w-full mb-4 unselectable">
            <div className="text-secondary leading-relaxed">
                <p className="mb-0">
                    Hypheus is becoming <strong className="text-foreground">Crowe Code</strong>, the
                    Crowe Logic IDE. This is the last update that will arrive automatically.
                </p>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-code"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        A new app, installed fresh
                    </div>
                    <div className="text-secondary leading-5">
                        Crowe Code v1.0.0 will ship as a separate application. Because it is a new app, your
                        current install will not auto-update into it. You will download Crowe Code once when it
                        is released, and this Hypheus install can stay as long as you like.
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-circle-info"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        Nothing changes today
                    </div>
                    <div className="text-secondary leading-5">
                        Everything you use right now keeps working. We will announce the Crowe Code release at{" "}
                        <a
                            target="_blank"
                            href="https://www.crowelogic.com"
                            rel="noopener"
                            className="text-accent"
                        >
                            crowelogic.com
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
