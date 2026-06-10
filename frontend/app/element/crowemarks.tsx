// Copyright 2026, Crowe Logic, Inc.
// SPDX-License-Identifier: Apache-2.0

// Brand marks rendered as inline SVG components rather than bundled asset
// files. Inline SVG removes the asset-path/packaging failure mode entirely
// (nothing for the bundler to emit or the packaged app to resolve), and the
// wordmark's <text> inherits document fonts, which <img src="*.svg">
// rendering cannot do.

interface MarkProps {
    className?: string;
}

export const CroweArcMark = ({ className }: MarkProps) => (
    <svg viewBox="0 0 24 24" fill="none" className={className} role="img" aria-label="Crowe Logic mark">
        <defs>
            <linearGradient id="crowe-arcmark-g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#E9C872" />
                <stop offset="0.45" stopColor="#D4AF37" />
                <stop offset="1" stopColor="#9A7A23" />
            </linearGradient>
        </defs>
        <g stroke="url(#crowe-arcmark-g)" strokeLinecap="round" strokeLinejoin="round" fill="none">
            <path d="M17.25 6.25A7.75 7.75 0 1 0 17.25 17.75" strokeWidth="2.4" />
            <path d="M10.75 9.25 14 12 10.75 14.75" strokeWidth="1.95" />
        </g>
    </svg>
);

export const CroweWordmark = ({ className }: MarkProps) => (
    <svg viewBox="0 0 720 160" fill="none" className={className} role="img" aria-label="Crowe Logic">
        <defs>
            <linearGradient id="crowe-wordmark-g" x1="0" y1="0" x2="1" y2="1">
                <stop offset="0" stopColor="#E9C872" />
                <stop offset="0.45" stopColor="#D4AF37" />
                <stop offset="1" stopColor="#9A7A23" />
            </linearGradient>
        </defs>
        <g
            transform="translate(20 20) scale(5)"
            stroke="url(#crowe-wordmark-g)"
            strokeLinecap="round"
            strokeLinejoin="round"
            fill="none"
        >
            <path d="M17.25 6.25A7.75 7.75 0 1 0 17.25 17.75" strokeWidth="2.4" />
            <path d="M10.75 9.25 14 12 10.75 14.75" strokeWidth="1.95" />
        </g>
        <text
            x="170"
            y="105"
            fontFamily="'Inter','Helvetica Neue',Arial,sans-serif"
            fontWeight="500"
            fontSize="62"
            letterSpacing="2"
            fill="#bfa669"
        >
            Crowe Logic
        </text>
    </svg>
);
