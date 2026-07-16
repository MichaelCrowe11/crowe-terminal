// Copyright 2026, Crowe Logic Inc. (modifications)
// Copyright 2025, Command Line Inc. (original work)
// SPDX-License-Identifier: Apache-2.0

import Logo from "@/app/asset/logo.svg";
import { OnboardingGradientBg } from "@/app/onboarding/onboarding-common";
import { atoms } from "@/app/store/global";
import { modalsModel } from "@/app/store/modalmodel";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { isDev } from "@/util/isdev";
import { fireAndForget } from "@/util/util";
import { useAtomValue } from "jotai";
import { useEffect } from "react";
import { Modal } from "./modal";

interface AboutModalVProps {
    versionString: string;
    updaterChannel: string;
    onClose: () => void;
}

const AboutModalV = ({ versionString, updaterChannel, onClose }: AboutModalVProps) => {
    const currentDate = new Date();

    return (
        <Modal className="pt-[34px] pb-[34px] overflow-hidden w-[450px]" onClose={onClose}>
            <OnboardingGradientBg />
            <div className="flex flex-col gap-[26px] w-full relative z-10">
                <div className="flex flex-col items-center justify-center gap-4 self-stretch w-full text-center">
                    <Logo />
                    <div className="text-[25px]">Hypheus</div>
                    <div className="leading-5">
                        The mycelial terminal.
                        <br />
                        A surface of the Crowe Logic platform.
                    </div>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center">
                    Client Version {versionString}
                    <br />
                    Update Channel: {updaterChannel}
                </div>
                <div className="grid grid-cols-2 gap-[10px] self-stretch w-full">
                    <a
                        href="https://github.com/MichaelCrowe11/crowe-terminal?ref=about"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-brands fa-github mr-2"></i>GitHub
                    </a>
                    <a
                        href="https://www.crowelogic.com/?ref=about"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-globe mr-2"></i>Crowe Logic
                    </a>
                    <a
                        href="https://github.com/wavetermdev/waveterm?ref=upstream"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-code-branch mr-2"></i>Attribution
                    </a>
                    <a
                        href="https://github.com/MichaelCrowe11/crowe-terminal/blob/main/NOTICE"
                        target="_blank"
                        rel="noopener"
                        className="inline-flex items-center justify-center px-4 py-2 rounded border border-border hover:bg-hoverbg transition-colors duration-200"
                    >
                        <i className="fa-sharp fa-light fa-book mr-2"></i>Acknowledgments
                    </a>
                </div>
                <div className="items-center gap-4 self-stretch w-full text-center text-[11px] opacity-70">
                    &copy; {currentDate.getFullYear()} Crowe Logic Inc. · Apache 2.0
                    <br />
                    See Acknowledgments for upstream credits.
                </div>
            </div>
        </Modal>
    );
};

AboutModalV.displayName = "AboutModalV";

const AboutModal = () => {
    const fullConfig = useAtomValue(atoms.fullConfigAtom);
    const versionString = `${fullConfig?.version ?? ""} (${isDev() ? "dev-" : ""}${fullConfig?.buildtime ?? ""})`;
    const updaterChannel = fullConfig?.settings?.["autoupdate:channel"] ?? "latest";

    useEffect(() => {
        fireAndForget(async () => {
            RpcApi.RecordTEventCommand(
                TabRpcClient,
                { event: "action:other", props: { "action:type": "about" } },
                { noresponse: true }
            );
        });
    }, []);

    return (
        <AboutModalV
            versionString={versionString}
            updaterChannel={updaterChannel}
            onClose={() => modalsModel.popModal()}
        />
    );
};

AboutModal.displayName = "AboutModal";

export { AboutModal, AboutModalV };
