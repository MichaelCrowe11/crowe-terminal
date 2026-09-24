// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import Logo from "@/app/asset/logo.svg";
import { Button } from "@/app/element/button";
import { FlexiModal } from "@/app/modals/modal";
import { CurrentOnboardingVersion, OnboardingGradientBg } from "@/app/onboarding/onboarding-common";
import { OnboardingFeatures } from "@/app/onboarding/onboarding-features";
import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/global";
import { disableGlobalKeybindings, enableGlobalKeybindings, globalRefocus } from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { OverlayScrollbarsComponent } from "overlayscrollbars-react";
import { useEffect, useRef, useState } from "react";
import { debounce } from "throttle-debounce";

type UpgradeMinorWelcomePageProps = {
    onMaybeLater: () => void;
};

const UpgradeMinorWelcomePage = ({ onMaybeLater }: UpgradeMinorWelcomePageProps) => {
    return (
        <div className="flex flex-col h-full">
            <header className="flex flex-col gap-2 border-b-0 p-0 mt-1 mb-4 w-full unselectable flex-shrink-0">
                <div className="flex justify-center">
                    <Logo />
                </div>
                <div className="text-center text-[25px] font-normal text-foreground">Welcome to Hypheus 0.15</div>
            </header>
            <OverlayScrollbarsComponent
                className="flex-1 overflow-y-auto min-h-0"
                options={{ scrollbars: { autoHide: "never" } }}
            >
                <div className="flex flex-col items-center gap-3 w-full mb-2 unselectable">
                    <div className="flex flex-col items-center gap-4">
                        <div className="flex flex-row gap-4 items-center">
                            <div className="flex h-[52px] px-3 items-center rounded-lg bg-hover text-accent text-[24px]">
                                <i className="fa fa-sparkles" />
                                <span className="font-bold ml-2 font-mono">Hypheus</span>
                            </div>
                            <div className="flex h-[52px] px-3 items-center rounded-lg bg-hover text-[18px]">
                                <i className="fa-sharp fa-solid fa-diagram-project text-accent" />
                                <span className="font-bold ml-2 text-accent">CroweLM modes</span>
                            </div>
                        </div>
                        <div className="text-secondary leading-relaxed max-w-[600px] text-left">
                            <p className="mb-4">
                                Hypheus is your terminal operator with full context. It reads your terminal output,
                                analyzes widgets, reads and writes files, and helps you solve problems&nbsp;faster.
                            </p>
                            <p className="mb-4">
                                <span className="font-semibold text-foreground">New in 0.15:</span> the CroweLM modes
                                run on Crowe Logic's model edge. Workspace, Code, Deep Work, Grow Ops, and Cultivation
                                Research support tools without a local model server. Before sending a request, open
                                Settings, then Secrets, choose Add New Secret, and save your own model-edge credential
                                as <span className="font-mono">CROWE_MODELS_KEY</span>.
                            </p>
                            <p className="mb-4">
                                <span className="font-semibold text-foreground">Since 0.14:</span> durable SSH sessions
                                survive network drops, laptop sleep, and restarts, with no tmux or screen. Your own
                                keys and local models still work through the engine presets.
                            </p>
                        </div>
                    </div>

                </div>
            </OverlayScrollbarsComponent>
            <footer className="unselectable flex-shrink-0 mt-4">
                <div className="flex flex-row items-center justify-center gap-2.5 [&>button]:!px-5 [&>button]:!py-2 [&>button]:text-sm [&>button]:!h-[37px]">
                    <Button className="font-[600]" onClick={onMaybeLater}>
                        Continue
                    </Button>
                </div>
            </footer>
        </div>
    );
};

UpgradeMinorWelcomePage.displayName = "UpgradeMinorWelcomePage";

const UpgradeOnboardingMinor = () => {
    const modalRef = useRef<HTMLDivElement | null>(null);
    const [pageName, setPageName] = useState<"welcome" | "features">("welcome");
    const [isCompact, setIsCompact] = useState<boolean>(window.innerHeight < 800);

    const updateModalHeight = () => {
        const windowHeight = window.innerHeight;
        setIsCompact(windowHeight < 800);
        if (modalRef.current) {
            const modalHeight = modalRef.current.offsetHeight;
            const maxHeight = windowHeight * 0.9;
            if (maxHeight < modalHeight) {
                modalRef.current.style.height = `${maxHeight}px`;
            } else {
                modalRef.current.style.height = "auto";
            }
        }
    };

    useEffect(() => {
        updateModalHeight();
        const debouncedUpdateModalHeight = debounce(150, updateModalHeight);
        window.addEventListener("resize", debouncedUpdateModalHeight);
        return () => {
            window.removeEventListener("resize", debouncedUpdateModalHeight);
        };
    }, []);

    useEffect(() => {
        disableGlobalKeybindings();
        return () => {
            enableGlobalKeybindings();
        };
    }, []);

    const handleMaybeLater = async () => {
        RpcApi.RecordTEventCommand(
            TabRpcClient,
            {
                event: "onboarding:githubstar",
                props: { "onboarding:githubstar": "later", "onboarding:page": "minorupgrade" },
            },
            { noresponse: true }
        );
        const clientId = ClientModel.getInstance().clientId;
        await RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", clientId),
            meta: { "onboarding:githubstar": false },
        });
        setPageName("features");
    };

    const handleFeaturesComplete = () => {
        const clientId = ClientModel.getInstance().clientId;
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", clientId),
            meta: { "onboarding:lastversion": CurrentOnboardingVersion },
        });
        globalStore.set(modalsModel.upgradeOnboardingOpen, false);
        setTimeout(() => {
            globalRefocus();
        }, 10);
    };

    let pageComp: React.JSX.Element = null;
    if (pageName === "welcome") {
        pageComp = (
            <UpgradeMinorWelcomePage onMaybeLater={handleMaybeLater} />
        );
    } else if (pageName === "features") {
        pageComp = <OnboardingFeatures onComplete={handleFeaturesComplete} />;
    }

    if (pageComp == null) {
        return null;
    }

    const paddingClass = isCompact ? "!py-3 !px-[30px]" : "!p-[30px]";
    const widthClass = pageName === "features" ? "w-[800px]" : "w-[600px]";

    return (
        <FlexiModal className={`${widthClass} rounded-[10px] ${paddingClass} relative overflow-hidden`} ref={modalRef}>
            <OnboardingGradientBg />
            <div className="flex flex-col w-full h-full relative z-10">{pageComp}</div>
        </FlexiModal>
    );
};

UpgradeOnboardingMinor.displayName = "UpgradeOnboardingMinor";

export { UpgradeMinorWelcomePage, UpgradeOnboardingMinor };
