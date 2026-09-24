// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { FlexiModal } from "@/app/modals/modal";
import { CurrentOnboardingVersion } from "@/app/onboarding/onboarding-common";
import { OnboardingFeatures, WorkspaceWelcome } from "@/app/onboarding/onboarding-features";
import { ClientModel } from "@/app/store/client-model";
import { globalStore } from "@/app/store/global";
import { disableGlobalKeybindings, enableGlobalKeybindings, globalRefocus } from "@/app/store/keymodel";
import { modalsModel } from "@/app/store/modalmodel";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect, useRef, useState } from "react";
import { debounce } from "throttle-debounce";

type UpgradeMinorWelcomePageProps = {
    onMaybeLater: () => void;
};

const UpgradeMinorWelcomePage = ({ onMaybeLater }: UpgradeMinorWelcomePageProps) => (
    <WorkspaceWelcome onComplete={onMaybeLater} />
);

UpgradeMinorWelcomePage.displayName = "UpgradeMinorWelcomePage";

const UpgradeOnboardingMinor = () => {
    const modalRef = useRef<HTMLDivElement | null>(null);
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

    const paddingClass = isCompact ? "!py-3 !px-4" : "!p-6";

    return (
        <FlexiModal
            className={`crowe-onboarding w-[560px] max-w-[calc(100vw-32px)] rounded-[8px] ${paddingClass} relative overflow-hidden`}
            ref={modalRef}
        >
            <OnboardingFeatures onComplete={handleFeaturesComplete} />
        </FlexiModal>
    );
};

UpgradeOnboardingMinor.displayName = "UpgradeOnboardingMinor";

export { UpgradeMinorWelcomePage, UpgradeOnboardingMinor };
