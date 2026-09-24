// Copyright 2026, Crowe Logic Inc.
// SPDX-License-Identifier: Apache-2.0

const Fs = require("node:fs/promises");
const Path = require("node:path");
const { builtinModules } = require("node:module");
const { pathToFileURL } = require("node:url");
const { createStorage } = require("./rehearsal-storage.cjs");

function inside(root, value) {
    if (typeof value !== "string" || !Path.isAbsolute(value)) return false;
    const relative = Path.relative(root, value);
    return relative === "" || (!relative.startsWith(`..${Path.sep}`) && relative !== ".." && !Path.isAbsolute(relative));
}

async function cleanPath(value, allowMissing = false) {
    if (typeof value !== "string" || !Path.isAbsolute(value) || Path.resolve(value) !== value) {
        throw new Error("Paths must be canonical absolute paths");
    }
    let cursor = Path.parse(value).root;
    for (const part of value.slice(cursor.length).split(Path.sep).filter(Boolean)) {
        cursor = Path.join(cursor, part);
        let stat;
        try {
            stat = await Fs.lstat(cursor);
        } catch (error) {
            if (allowMissing && error.code === "ENOENT") return;
            throw error;
        }
        if (stat.isSymbolicLink() || (!stat.isDirectory() && cursor !== value)) {
            throw new Error("Symlink or non-directory ancestor rejected");
        }
    }
}

function externalImportsPlugin() {
    const builtins = new Set(builtinModules);
    return {
        name: "rehearsal-original-importer",
        setup(build) {
            build.onResolve({ filter: /.*/ }, async (args) => {
                if (args.pluginData?.rehearsalexternal || args.kind === "entry-point") return;
                if (args.path.startsWith("node:") || builtins.has(args.path)) return { path: args.path, external: true };
                const local = args.path.startsWith(".") || Path.isAbsolute(args.path);
                if (local && Path.extname(args.path) !== ".mjs") return;
                const requested = local ? Path.resolve(args.resolveDir, args.path) : null;
                if (local) await cleanPath(requested);
                const result = await build.resolve(args.path, {
                    importer: args.importer,
                    resolveDir: args.resolveDir,
                    kind: args.kind,
                    namespace: args.namespace,
                    pluginData: { rehearsalexternal: true },
                });
                if (result.errors.length) return { errors: result.errors };
                if (!Path.isAbsolute(result.path)) throw new Error("Dependency did not resolve to an absolute path");
                if (local) {
                    if (result.path !== requested || result.suffix || (result.namespace && result.namespace !== "file")) {
                        throw new Error("Local ESM resolution changed module identity");
                    }
                    await cleanPath(result.path);
                    const stat = await Fs.lstat(result.path);
                    if (!stat.isFile() || stat.nlink !== 1 || await Fs.realpath(result.path) !== result.path) {
                        throw new Error("Local ESM must be a canonical regular file without links");
                    }
                }
                return { path: result.path, external: true };
            });
        },
    };
}

function absoluteInput(input, root) {
    if (typeof input === "string") return Path.resolve(root, input);
    if (Array.isArray(input)) return input.map((item) => absoluteInput(item, root));
    if (input && typeof input === "object") return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, absoluteInput(value, root)]));
    throw new Error("Explicit build inputs required");
}

function safeOutputs(build, outdir) {
    if (build.outDir !== outdir || build.emptyOutDir !== false || build.watch) throw new Error("Unsafe build output or watch configuration");
    if (build.assetsDir && (Path.isAbsolute(build.assetsDir) || build.assetsDir.split(/[\\/]/).includes(".."))) throw new Error("Unsafe assets directory");
    if (typeof build.manifest === "string" && (Path.isAbsolute(build.manifest) || build.manifest.split(/[\\/]/).includes(".."))) throw new Error("Unsafe manifest path");
    for (const output of [build.rollupOptions?.output].flat().filter(Boolean)) {
        if (output.file || (output.dir && Path.resolve(output.dir) !== outdir)) throw new Error("Alternate Rollup output rejected");
        for (const field of ["entryFileNames", "chunkFileNames", "assetFileNames", "sourcemapFile"]) {
            const value = output[field];
            if (typeof value === "function" || (typeof value === "string" && (Path.isAbsolute(value) || value.split(/[\\/]/).includes("..")))) {
                throw new Error("Unsafe Rollup filename rejected");
            }
        }
    }
}

function adaptConfig(config, paths) {
    if (!config || config.build?.outDir) throw new Error("Top-level output override rejected");
    const result = { ...config };
    for (const [target, directory] of Object.entries({ main: "main", preload: "preload", renderer: "frontend" })) {
        const original = config[target];
        if (!original) throw new Error(`Missing ${target} configuration`);
        const root = Path.resolve(paths.repository, original.root ?? ".");
        if (!inside(paths.repository, root)) throw new Error("Source root escapes repository");
        const outdir = Path.join(paths.destination, "app", "dist", directory);
        const cache = Path.join(paths.destination, "cache", target);
        const build = {
            ...original.build,
            outDir: outdir,
            emptyOutDir: false,
            watch: null,
            rollupOptions: {
                ...original.build?.rollupOptions,
                input: absoluteInput(original.build?.rollupOptions?.input, root),
            },
        };
        safeOutputs(build, outdir);
        const guard = {
            name: `rehearsal-owned-output-${target}`,
            enforce: "post",
            async configResolved(resolved) {
                if (resolved.command !== "build" || resolved.envFile !== false || resolved.server?.watch || resolved.root !== root) {
                    throw new Error("Only environment-free non-watching build resolution is permitted");
                }
                // Vite normalizes envDir to false when envFile is false, regardless of the configured directory.
                if (resolved.envDir !== false) throw new Error("Resolved environment loading must remain disabled");
                if (resolved.cacheDir !== cache) throw new Error("Writable configuration escaped owned paths");
                safeOutputs(resolved.build, outdir);
                await cleanPath(paths.destination);
                for (const value of [cache, outdir, paths.tmp]) {
                    if (!inside(paths.destination, value)) throw new Error("Writable path escaped destination");
                    await cleanPath(value, true);
                }
            },
        };
        const aliases = original.resolve?.alias;
        result[target] = {
            ...original,
            root,
            envFile: false,
            envDir: paths.tmp,
            cacheDir: cache,
            server: { ...original.server, open: false, watch: null },
            build,
            resolve: {
                ...original.resolve,
                ...(aliases && !Array.isArray(aliases) ? { alias: Object.fromEntries(Object.entries(aliases).map(([key, value]) => [key, typeof value === "string" && !Path.isAbsolute(value) ? Path.resolve(root, value) : value])) } : {}),
            },
            plugins: [...(original.plugins ?? []), guard],
        };
    }
    return result;
}

async function prepareBuild(options, dependencies = {}) {
    // Native esbuild starts a service child. The caller must supply its API from an approved minimal-environment context.
    if (typeof dependencies.esbuild?.build !== "function") throw new Error("Explicit esbuild API dependency required; no implicit subprocess launch");
    if (options.estatecomplete !== true) throw new Error("Caller must declare the complete retained rehearsal estate");
    await cleanPath(options.repository);
    const source = Path.join(options.repository, "electron.vite.config.ts");
    await cleanPath(source);
    if (!(await Fs.lstat(source)).isFile()) throw new Error("Config source must be a regular file");
    await cleanPath(options.destination, true);
    if (inside(options.repository, options.destination) || inside(options.destination, options.repository)) throw new Error("Destination and repository must be disjoint");
    const storage = await createStorage(options, dependencies.storage);
    const paths = {
        repository: options.repository,
        destination: storage.destination,
        tmp: Path.join(storage.destination, "tmp"),
    };
    for (const directory of ["app", "app/dist", "cache", "tmp"]) {
        await storage.check();
        await Fs.mkdir(Path.join(storage.destination, directory), { mode: 0o700 });
    }
    const esbuild = dependencies.esbuild;
    const compiled = await esbuild.build({
        absWorkingDir: options.repository,
        entryPoints: [source],
        bundle: true,
        write: false,
        platform: "node",
        format: "esm",
        target: "node22",
        sourcemap: false,
        tsconfigRaw: {},
        logLevel: "silent",
        plugins: [externalImportsPlugin()],
    });
    if (compiled.outputFiles?.length !== 1) throw new Error("Expected exactly one in-memory config module");
    await storage.write("prepared-config.mjs", Buffer.from(compiled.outputFiles[0].contents));
    const prepared = Path.join(storage.destination, "prepared-config.mjs");
    const loader = Path.join(storage.destination, "electron.rehearsal.mjs");
    // Computed URLs keep electron-vite's config bundler from pulling plugin dependencies into its temporary module.
    const code = `const paths = ${JSON.stringify(paths)};\nconst sourceUrl = ${JSON.stringify(pathToFileURL(prepared).href)};\nconst adapterUrl = ${JSON.stringify(pathToFileURL(__filename).href)};\nexport default async (env) => {\n    const source = (await import(sourceUrl)).default;\n    const adapter = (await import(adapterUrl)).default;\n    const config = await (typeof source === "function" ? source(env) : source);\n    return adapter.adaptConfig(config, paths);\n};\n`;
    await storage.write("electron.rehearsal.mjs", Buffer.from(code));
    await storage.check();
    return {
        status: "PREPARED_ONLY",
        paths,
        configfile: loader,
        preparedfile: prepared,
        limits: storage.config,
        safety: {
            actualbuild: "NOT_RUN",
            quota: "PREPARATION_ONLY; actual bundle writes are not budget-enforced by this adapter",
            prerequisite: "Caller-supplied esbuild API must run in a separately approved minimal-environment context",
            plugins: "Original config plugins are preserved, not sandboxed; their arbitrary writes require separate review",
        },
        invocation: {
            status: "NOT_EXECUTED",
            module: Path.join(options.repository, "node_modules/electron-vite/dist/index.js"),
            method: "build",
            options: { root: storage.destination, configFile: loader, envFile: false, mode: "development" },
            cwd: options.repository,
            env: { HOME: paths.tmp, TMPDIR: paths.tmp, XDG_CACHE_HOME: Path.join(storage.destination, "cache") },
            requiresapproval: true,
            requiresexternalbudgetcontrol: true,
        },
    };
}

module.exports = { prepareBuild, adaptConfig, externalImportsPlugin };
