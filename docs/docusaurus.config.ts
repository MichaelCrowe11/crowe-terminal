import type { Config } from "@docusaurus/types";
import rehypeHighlight from "rehype-highlight";
import { docOgRenderer } from "./src/renderer/image-renderers";

const baseUrl = process.env.EMBEDDED ? "/docsite/" : "/";

const config: Config = {
    title: "Hypheus Documentation",
    tagline: "A terminal with graphical blocks, remote connections, and durable sessions",
    favicon: "img/logo/hypheus-mark.svg",

    // Set the production url of your site here
    url: "https://docs.hypheus.com/",
    // Set the /<baseUrl>/ pathname under which your site is served
    // For GitHub pages deployment, it is often '/<projectName>/'
    baseUrl,

    // GitHub pages deployment config.
    // If you aren't using GitHub pages, you don't need these.
    organizationName: "MichaelCrowe11", // Usually your GitHub org/user name.
    projectName: "crowe-terminal", // Usually your repo name.
    deploymentBranch: "main",

    onBrokenAnchors: "ignore",
    onBrokenLinks: "throw",
    onBrokenMarkdownLinks: "warn",
    trailingSlash: false,

    // Even if you don't use internationalization, you can use this field to set
    // useful metadata like html lang. For example, if your site is Chinese, you
    // may want to replace "en" with "zh-Hans".
    i18n: {
        defaultLocale: "en",
        locales: ["en"],
    },
    plugins: [
        [
            "content-docs",
            {
                path: "docs",
                routeBasePath: "/",
                exclude: ["features/**"],
                editUrl: !process.env.EMBEDDED
                    ? "https://github.com/MichaelCrowe11/crowe-terminal/edit/main/docs/"
                    : undefined,
                rehypePlugins: [rehypeHighlight],
            } as import("@docusaurus/plugin-content-docs").Options,
        ],
        "ideal-image",
        [
            "@docusaurus/plugin-sitemap",
            {
                changefreq: "daily",
                filename: "sitemap.xml",
            },
        ],
        !process.env.EMBEDDED && [
            "@waveterm/docusaurus-og",
            {
                path: "./preview-images", // relative to the build directory
                imageRenderers: {
                    "docusaurus-plugin-content-docs": docOgRenderer,
                },
            },
        ],
        "docusaurus-plugin-sass",
        "@docusaurus/plugin-svgr",
    ].filter((v) => v),
    themes: [
        ["classic", { customCss: "src/css/custom.scss" }],
        !process.env.EMBEDDED && "@docusaurus/theme-search-algolia",
    ].filter((v) => v),
    themeConfig: {
        docs: {
            sidebar: {
                hideable: false,
                autoCollapseCategories: false,
            },
        },
        colorMode: {
            defaultMode: "light",
            disableSwitch: false,
            respectPrefersColorScheme: true,
        },
        navbar: {
            logo: {
                alt: "Hypheus",
                src: "img/logo/hypheus-light.png",
                srcDark: "img/logo/hypheus-dark.png",
                href: "https://hypheus.com/",
            },
            hideOnScroll: true,
            items: [
                {
                    type: "doc",
                    position: "left",
                    docId: "index",
                    label: "Docs",
                },
                !process.env.EMBEDDED
                    ? [
                          {
                              href: "https://github.com/MichaelCrowe11/crowe-terminal",
                              position: "right",
                              className: "header-link-custom custom-icon-github",
                              "aria-label": "GitHub repository",
                          },
                      ]
                    : [],
            ].flat(),
        },
        metadata: [
            {
                name: "keywords",
                content:
                    "terminal, developer, development, command, line, hypheus, linux, macos, windows, connection, ssh, cli, documentation, docs, graphical, widgets, blocks, remote, go, golang, react, typescript, javascript",
            },
            {
                property: "og:type",
                content: "website",
            },
            {
                property: "og:site_name",
                content: "Hypheus Documentation",
            },
            {
                name: "application-name",
                content: "Hypheus Documentation",
            },
            {
                name: "apple-mobile-web-app-title",
                content: "Hypheus Documentation",
            },
        ],
        footer: {
            copyright: `Copyright © 2026 Crowe Logic, Inc. Portions derived from Wave Terminal, © Command Line Inc., Apache-2.0. Built with Docusaurus.`,
        },
        algolia: {
            appId: "B6A8512SN4",
            apiKey: "e879cd8663f109b2822cd004d9cd468c",
            indexName: "waveterm",
        },
    },
    headTags: [
        {
            tagName: "link",
            attributes: {
                rel: "preload",
                as: "font",
                type: "font/woff2",
                "data-next-font": "size-adjust",
                href: `${baseUrl}fontawesome/webfonts/fa-sharp-regular-400.woff2`,
            },
        },
        {
            tagName: "link",
            attributes: {
                rel: "preload",
                as: "font",
                type: "font/woff2",
                "data-next-font": "size-adjust",
                href: `${baseUrl}fontawesome/webfonts/fa-sharp-solid-900.woff2`,
            },
        },
        {
            tagName: "link",
            attributes: {
                rel: "sitemap",
                type: "application/xml",
                title: "Sitemap",
                href: `${baseUrl}sitemap.xml`,
            },
        },
    ].filter((v) => v),
    stylesheets: [
        `${baseUrl}fontawesome/css/fontawesome.min.css`,
        `${baseUrl}fontawesome/css/sharp-regular.min.css`,
        `${baseUrl}fontawesome/css/sharp-solid.min.css`,
    ],
    staticDirectories: ["static", "storybook"],
};

export default config;
