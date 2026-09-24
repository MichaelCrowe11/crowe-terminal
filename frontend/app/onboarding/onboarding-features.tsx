// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@/app/element/button";
import { ClientModel } from "@/app/store/client-model";
import * as WOS from "@/app/store/wos";
import { RpcApi } from "@/app/store/wshclientapi";
import { TabRpcClient } from "@/app/store/wshrpcutil";
import { useEffect } from "react";
import { CurrentOnboardingVersion } from "./onboarding-common";

export const WorkspaceWelcome = ({ onComplete }: { onComplete: () => void }) => (
    <section className="flex min-h-0 flex-col gap-6 text-sm text-secondary">
        <div className="min-h-0 overflow-y-auto">
            <h1 className="crowe-welcome-title mb-4 text-2xl font-normal text-foreground">
                Your workspace, ready to open
            </h1>
            <p className="leading-relaxed">
                Keep your terminal, files, and editor together. Start with the work in front of you.
            </p>
            <ul className="mt-6 divide-y divide-border border-y border-border">
                <li className="py-3">Open a terminal or choose a tool from the launcher.</li>
                <li className="py-3">Use the operator panel when you want help with your workspace.</li>
                <li className="py-3">
                    Choose Connect account in the panel. Sign in to Crowe ID in your browser and enter the displayed
                    code.
                </li>
            </ul>
            <p className="mt-4 leading-relaxed">
                Connecting does not read files or run commands. Tool authority is a separate choice.
            </p>
        </div>
        <footer className="flex shrink-0 justify-end">
            <Button
                className="outlined grey !border !border-accent !rounded !px-4 !py-2 cursor-pointer focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                onClick={onComplete}
            >
                Open workspace
            </Button>
        </footer>
    </section>
);

export const OnboardingFeatures = ({ onComplete }: { onComplete: () => void }) => {
    useEffect(() => {
        const clientId = ClientModel.getInstance().clientId;
        RpcApi.SetMetaCommand(TabRpcClient, {
            oref: WOS.makeORef("client", clientId),
            meta: { "onboarding:lastversion": CurrentOnboardingVersion },
        });
        RpcApi.RecordTEventCommand(TabRpcClient, {
            event: "onboarding:start",
            props: {
                "onboarding:version": CurrentOnboardingVersion,
            },
        });
    }, []);

    return <WorkspaceWelcome onComplete={onComplete} />;
};
