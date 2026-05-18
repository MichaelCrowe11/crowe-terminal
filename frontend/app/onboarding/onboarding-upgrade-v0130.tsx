// Copyright 2025, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

const UpgradeOnboardingModal_v0_13_0_Content = () => {
    return (
        <div className="flex flex-col items-start gap-6 w-full mb-4 unselectable">
            <div className="text-secondary leading-relaxed">
                <p className="mb-0">
                    Crowe Terminal v0.13 brings the managed CroweLM workspace, a redesigned account flow, and improved
                    terminal functionality.
                </p>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-sparkles"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">
                        Managed CroweLM Workspace
                    </div>
                    <div className="text-secondary leading-5">
                        <ul className="list-disc list-outside space-y-1 pl-5">
                            <li>
                                <strong>Signed Account</strong> - Sign in once and work from the Crowe Logic workspace
                            </li>
                            <li>
                                <strong>Workspace Tools</strong> - Terminal, files, browser blocks, and editor tools
                            </li>
                            <li>
                                <strong>CroweLM Channels</strong> - Code, research, workspace, and grow operations
                            </li>
                            <li>
                                <strong>No Provider Setup</strong> - Crowe Logic handles routing and model access
                            </li>
                        </ul>
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-sliders"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">Workspace Settings</div>
                    <div className="text-secondary leading-5">
                        <ul className="list-disc list-outside space-y-1 pl-5">
                            <li>
                                <strong>New Config Interface</strong> - Dedicated widget accessible from the sidebar
                            </li>
                            <li>
                                <strong>Better Organization</strong> - Browse and edit settings with improved validation
                                and error handling
                            </li>
                            <li>
                                <strong>Integrated Secrets</strong> - Manage connection credentials from the config widget
                            </li>
                        </ul>
                    </div>
                </div>
            </div>

            <div className="flex w-full items-start gap-4">
                <div className="flex-shrink-0">
                    <i className="text-[24px] text-accent fa-solid fa-terminal"></i>
                </div>
                <div className="flex flex-col items-start gap-2 flex-1">
                    <div className="text-foreground text-base font-semibold leading-[18px]">Terminal Updates</div>
                    <div className="text-secondary leading-5">
                        <ul className="list-disc list-outside space-y-1 pl-5">
                            <li>
                                <strong>Bracketed Paste Mode</strong> - Enabled by default for better multi-line paste
                                behavior
                            </li>
                            <li>
                                <strong>Windows Paste Fix</strong> - Ctrl+V now works as standard paste on Windows
                            </li>
                            <li>
                                <strong>SSH Password Storage</strong> - Store SSH passwords in Crowe Terminal's secret store
                            </li>
                        </ul>
                    </div>
                </div>
            </div>
        </div>
    );
};

UpgradeOnboardingModal_v0_13_0_Content.displayName = "UpgradeOnboardingModal_v0_13_0_Content";

export { UpgradeOnboardingModal_v0_13_0_Content };
