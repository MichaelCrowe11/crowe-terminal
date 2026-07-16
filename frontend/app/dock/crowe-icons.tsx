// Copyright 2026, Command Line Inc.
// SPDX-License-Identifier: Apache-2.0

// Bespoke mycelium/organic icon set for the utility dock. Hand-authored line
// glyphs (24x24, currentColor stroke) so the rail reads as its own language
// rather than a generic icon-font drop-in. Each pairs a living motif with the
// tool: a breathing vitals trace, a spore, a hyphal thinking tip, a nib, a
// mycelial network.

interface IconProps {
    className?: string;
    size?: number;
}

function svgProps(size: number) {
    return {
        width: size,
        height: size,
        viewBox: "0 0 24 24",
        fill: "none" as const,
        stroke: "currentColor",
        strokeWidth: 1.5,
        strokeLinecap: "round" as const,
        strokeLinejoin: "round" as const,
    };
}

export const VitalsIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <path d="M2 13h4.1c.45 0 .84-.29 1-.71l1.35-3.4c.19-.5.9-.48 1.07.03l2.1 6.4c.17.52.9.53 1.09.02l1.2-3.24c.15-.4.53-.66.95-.66H22" />
        <circle cx="19.4" cy="8.7" r="1.15" fill="currentColor" stroke="none" />
    </svg>
);

export const SporeIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <circle cx="12" cy="12" r="7.3" strokeDasharray="1.4 2.6" opacity="0.85" />
        <circle cx="12" cy="12" r="3" fill="currentColor" stroke="none" />
        <circle cx="12" cy="3.4" r="1" fill="currentColor" stroke="none" />
        <circle cx="20.1" cy="15" r="1" fill="currentColor" stroke="none" />
        <circle cx="4.6" cy="16.4" r="1" fill="currentColor" stroke="none" />
    </svg>
);

export const HyphaeIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <circle cx="11.5" cy="12.2" r="2.1" fill="currentColor" stroke="none" />
        <path d="M11.9 10.2c.1-2.6 1.5-4.2 3.6-4.8" />
        <path d="M13.5 12c2.3-.2 3.8-1.5 4.5-3.6" />
        <path d="M13 13.9c1.7 1.3 3.7 1.4 5.4.5" />
        <path d="M10 13.7c-1.2 1.9-3 2.6-4.9 2.4" />
        <path d="M9.6 11c-2.1-.7-3.2-2.2-3.5-4.3" />
        <circle cx="15.5" cy="5.2" r=".9" fill="currentColor" stroke="none" />
        <circle cx="18.3" cy="8" r=".9" fill="currentColor" stroke="none" />
        <circle cx="18.7" cy="14.6" r=".9" fill="currentColor" stroke="none" />
        <circle cx="5" cy="16.3" r=".9" fill="currentColor" stroke="none" />
        <circle cx="5.9" cy="6.5" r=".9" fill="currentColor" stroke="none" />
    </svg>
);

export const NibIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <path d="M8.6 4.2h6.8l1.5 9.1-4.9 6.4-4.9-6.4z" />
        <path d="M12 13.6V20" />
        <circle cx="12" cy="10.6" r="1.15" fill="currentColor" stroke="none" />
    </svg>
);

export const NetworkIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <path d="M5.4 6.2Q9 9 11.7 11.7" opacity="0.9" />
        <path d="M18.6 7Q15 9.2 12.3 11.9" opacity="0.9" />
        <path d="M11.7 12.4Q9 15.3 6.2 17.8" opacity="0.9" />
        <path d="M12.3 12.4Q15.2 15 18 17.4" opacity="0.9" />
        <path d="M6.6 18Q12 19.6 17.6 17.6" opacity="0.7" />
        <circle cx="12" cy="12" r="2.2" fill="currentColor" stroke="none" />
        <circle cx="5.2" cy="5.9" r="1.5" />
        <circle cx="18.8" cy="6.7" r="1.5" />
        <circle cx="6" cy="18.3" r="1.5" />
        <circle cx="18.2" cy="17.8" r="1.5" />
    </svg>
);

export const AssistantIcon = ({ className, size = 22 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <path d="M4 5.5h16a1.6 1.6 0 0 1 1.6 1.6v7.4a1.6 1.6 0 0 1-1.6 1.6H9.6L5 20.6V16.1H4A1.6 1.6 0 0 1 2.4 14.5V7.1A1.6 1.6 0 0 1 4 5.5Z" />
        <circle cx="8.4" cy="10.9" r="1" fill="currentColor" stroke="none" />
        <circle cx="12" cy="10.9" r="1" fill="currentColor" stroke="none" />
        <circle cx="15.6" cy="10.9" r="1" fill="currentColor" stroke="none" />
    </svg>
);

export const CloseIcon = ({ className, size = 16 }: IconProps) => (
    <svg className={className} {...svgProps(size)} aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18" />
    </svg>
);
