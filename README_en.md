# WasmNest

**A dual-end Wasm application host: one app contract for desktop and Android, with every product capability shipped as an independently built wasm app.**

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Tauri 2](https://img.shields.io/badge/Tauri-2-24C8D8?logo=tauri&logoColor=white)](https://tauri.app)
[![Vue 3](https://img.shields.io/badge/Vue-3-42B883?logo=vuedotjs&logoColor=white)](https://vuejs.org)
[![Rust](https://img.shields.io/badge/Rust-stable-DEA584?logo=rust&logoColor=white)](https://www.rust-lang.org)
[![WebAssembly](https://img.shields.io/badge/WebAssembly-Component-654FF0?logo=webassembly&logoColor=white)](https://component-model.bytecodealliance.org)
[![Wasmtime](https://img.shields.io/badge/Wasmtime-Runtime-00263E)](https://wasmtime.dev)
[![Status](https://img.shields.io/badge/status-alpha-orange)](#project-status)

English | [简体中文](README.md)

WasmNest is a dual-end wasm application host built on the [WebAssembly Component Model](https://component-model.bytecodealliance.org/): Tauri 2 + Vue 3 (Windows / macOS / Linux) on desktop, Tauri 2 (Android) + Vue 3 on mobile.

The core problem it solves: **decoupling product capabilities from host code entirely**. Terminals, AI chat, file transfer, agent management — none of them live in the host. Each ships as an independent wasm app that runs in a wasmtime sandbox, is loaded under explicit permissions and is unloaded the moment it leaves the surface. The host only provides the generic engine, security gates and assembly — apps can grow freely while the host stays minimal.

## Goal

WasmNest is committed to making it fast to build **personal local "mini-programs"** — your own **small-tools platform**: write a small tool, drop it into the host and it just works; tools run on your own device, and what they can do is decided by permissions — nothing granted by default, everything approved explicitly.

> The project is in its early development phase (`0.0.1`): there are no real users yet and no external ABI compatibility obligations, so interfaces and shapes may change directly. What is stable is the design boundary, not the version number.

## Features and Advantages

| Technology | Effect | Problem it solves |
| --- | --- | --- |
| **wasmtime sandbox**: one isolated Component instance per app, explicit capability imports | Apps start with zero system capabilities and only get the file / network access they were approved for | A runaway or malicious app is contained to the smallest possible radius |
| **WIT / Component Model cross-language contracts**: host and app talk only through interfaces, sharing no code | Apps can be written in any language that can emit a wasm Component; the host doesn't care about language or toolchain | Plugin ecosystems locked to the host's language and runtime |
| **Capability is permission**: `plugin.json` declarations ∩ user approval, nothing granted by default | What an app can do is decided by the user, with high-risk abilities split by domain | Installing an app means handing over all permissions |
| **Independently built app bundles + assembly mechanism** | Add, swap or remove capabilities without touching the host; apps unload when they leave | Features coupled into the host, forcing a full release for every change |
| **One shared WIT and SDK across both ends** | Write an app once, load it on desktop and Android | Split ecosystems and duplicated work |
| **Thin host + cross-repo version fingerprints** | The host only does engines and assembly; contract drift fails immediately | Host bloat and integration issues lurking silently |

## Design Principles

| Principle | Meaning |
| --- | --- |
| **Thin host** | The host only answers "how does the mechanism work", never "what is this feature, who is it for, how is it organized". Types, flows, storage, defaults and lifecycle callbacks defined by product semantics all belong to apps; this boundary is pinned by test locks. |
| **Capability is permission** | Nothing is granted by default. Effective permissions = declarations in `plugin.json` ∩ user approval; high-risk surfaces such as files, network, processes, PTY and WebSocket are split by domain. On mobile, approval is pinned to content SHA-256, so replacing the directory automatically revokes it. |
| **Contract first** | The core WIT lives in the capability repo; end composition and SDK artifacts live in the platform repo. Cross-repo versions are pinned by [`release-manifest.json`](release-manifest.json) using exact tags, contract versions and WIT fingerprints — any drift turns red. |
| **Dual-end lockstep** | Both ends share one mechanism core and one wasmtime version, while their assembly surfaces evolve separately. Cross-end protocols (HTTP / WS / auth / file transfer) must be deployed on both ends together. |

## Desktop and Mobile

| | Desktop | Mobile |
| --- | --- | --- |
| Host | Tauri 2 + Vue 3 (Windows / macOS / Linux) | Tauri 2 + Vue 3 (Android) |
| App loading | Full-screen mount of an independently built app bundle in the same window | Runtime surface registration in the host shell |
| App isolation | wasmtime sandbox instance + explicit capability imports | Same, plus content-bound approval on Android |

Desktop apps are unloaded as soon as they leave the app surface; the host holds no app-internal state. Assembly details: [`docs/architecture.md`](docs/architecture.md), [`docs/frontend.md`](docs/frontend.md).

## Four Repositories

WasmNest consists of four peer repositories, expected in a sibling layout:

```text
<workspace>/
├─ wasmnest/        platform: dual-end hosts + per-end SDKs + build / release tooling
├─ wasmnest-lib/    capability: application-agnostic engines + WIT contract source of truth
├─ wasmnest-apps/   applications: all business wasm apps
└─ wasmnest-test/   testing: real cross-end integration tests (zero mocks)
```

| Repository | Role | Contents |
| --- | --- | --- |
| **[wasmnest](https://github.com/7ZAI/wasmnest)** (this repo) | Host and release surface | Desktop / mobile hosts, per-end SDKs, WIT composition, cross-repo version manifest, build and packaging tools |
| **[wasmnest-lib](https://github.com/7ZAI/wasmnest-lib)** | Reusable mechanisms | wasm runtime core, host API implementation layer, server transports, PTY / mDNS / notify / crypto engines, contract constants |
| **[wasmnest-apps](https://github.com/7ZAI/wasmnest-apps)** | Business home | BedCode, AI Chatbox, File Transfer, Agent Hub and other wasm apps |
| **[wasmnest-test](https://github.com/7ZAI/wasmnest-test)** | Cross-end gate | Real mobile client ↔ real desktop server interop, cross-repo contract locks |

The platform consumes the capability repo directly through Cargo sibling paths (no copies, no submodules). Non-standard layouts can override `WASMNEST_LIB_ROOT` and `WASMNEST_APPS_ROOT`; a missing directory fails visibly instead of returning a possibly invalid path.

## Built-in Apps

| App | Plugin id | Ends | Capability |
| --- | --- | --- | --- |
| **BedCode** | `com.wasmnest.terminal-session` | desktop + mobile | Terminal session center: pairing and trust, session lifecycle orchestration, task queue and agent integration; the mobile side is a remote terminal controller |
| **AI Chatbox** | `com.wasmnest.ai-chatbox` | desktop + mobile | Multi-provider AI chat: streaming output, multi-session management, JSONL conversation logs |
| **File Transfer** | `com.wasmnest.file-transfer` | desktop + mobile | LAN peer discovery and bidirectional file transfer: queues, pause/resume, resumable transfers, shared directories |
| **Agent Hub** | `com.wasmnest.agent-hub` | desktop | Unified console for Agent CLIs: install/uninstall, Skills management, provider configuration, usage stats |

## Quick Start

### Prerequisites

| Dependency | Notes |
| --- | --- |
| Node.js | ≥ 22 (development uses 24) |
| pnpm | `12.2.1`, pinned by the root `package.json` `packageManager`; `corepack enable` is recommended |
| Rust | stable (development uses 1.98); desktop apps also need the wasip3 nightly pinned by `scripts/wasip3-toolchain.sh` |
| sccache | **Required.** The root `.cargo/config.toml` forces `rustc-wrapper = "sccache"`; without it cargo fails immediately (intentional) |
| Tauri 2 | Desktop system dependencies: [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) |
| Android | Mobile only: Android Studio / SDK / NDK / JDK, versions matching the Tauri 2 Android toolchain |

### Clone the Four Repositories

```bash
mkdir wasmnest-workspace && cd wasmnest-workspace
git clone https://github.com/7ZAI/wasmnest.git
git clone https://github.com/7ZAI/wasmnest-lib.git
git clone https://github.com/7ZAI/wasmnest-apps.git
git clone https://github.com/7ZAI/wasmnest-test.git
```

### Install Dependencies

```bash
cd wasmnest

# Root dependencies (eslint / prettier / husky / root scripts)
pnpm install

# Each host is an independent workspace and must be installed separately
pnpm --dir wasmnest-desktop install
pnpm --dir wasmnest-mobile install

# WIT artifacts match their sources (day-to-day gate)
pnpm run check:wit

# App repo root dependencies + every app project (each app is its own pnpm workspace)
cd ../wasmnest-apps
pnpm install
for app in apps/*/desktop apps/*/mobile; do
  [ -f "$app/package.json" ] && (cd "$app" && pnpm install)
done
```

> `pnpm run check:manifest` validates **release assembly state**: the HEAD of `../wasmnest-lib` and `../wasmnest-apps` must sit exactly on the tags pinned by the manifest (with clean working trees). Day-to-day branches usually lead the tags, so a red result there is expected.

### Run the Desktop Host

```bash
cd ../wasmnest
pnpm --dir wasmnest-desktop run tauri:dev
```

The first launch automatically builds missing or stale app artifacts and starts the plugin watcher. If app dependencies are not installed yet, finish the previous step first.

### Run the Mobile Host

```bash
cd wasmnest-mobile
pnpm run tauri:android:dev
```

Requires a working Android device or emulator. After app changes land in the host, the app must be re-activated manually.

### Build All Apps

```bash
cd wasmnest-desktop && pnpm run plugins:build
cd ../wasmnest-mobile && pnpm run plugins:build
```

Artifacts are written to `src-tauri/resources/plugins/<end>/<id>/`, which is not tracked. During desktop development the runtime copy lives in `target/debug/resources/plugins/desktop/`; deleting the source directory does not synchronize that copy.

## Common Commands

| Location | Command | Purpose |
| --- | --- | --- |
| Platform root | `pnpm run check:wit` | WIT composition drift lock (day-to-day gate) |
| Desktop | `pnpm run tauri:dev` | Host development (prebuild gaps + frontend watch) |
| Desktop | `pnpm run plugins:dev -- --plugin <id>` | Debug a single app |
| Desktop / Mobile | `pnpm run plugins:build` | Build all built-in apps |
| Desktop / Mobile | `pnpm run test:run` | Host and SDK vitest suites |
| Mobile | `pnpm run tauri:android:dev` | Android development |

> Always use pnpm. **Do not run `pnpm run test`** (vitest watch never exits); use `test:run`. For the full command set (release packaging such as `tauri:build` / `host:pack`, `cargo test`, E2E, etc.) see [`docs/commands.md`](docs/commands.md).

## Project Layout

```text
wasmnest/
├─ wasmnest-desktop/            # Tauri 2 desktop host
│  ├─ src/                      # Host shell (home / system pages / mount slot / task preview)
│  ├─ src-tauri/                # Rust host: plugin wiring + security gates + server
│  ├─ packages/plugin-sdk-desktop/
│  ├─ scripts/                  # dev-run / plugin-build / plugin-watch / host:pack
│  └─ e2e/ · bench/
├─ wasmnest-mobile/             # Tauri 2 Android host
│  ├─ src/                      # Host shell (shell registry + runtime surfaces)
│  ├─ src-tauri/                # Rust host + hand-written Kotlin under gen/android
│  └─ packages/plugin-sdk-mobile/
├─ scripts/                     # WIT composition / manifest checks / path resolvers / packaging / versions
├─ tools/componentize/          # core module → Component componentizer
├─ docs/                        # Architecture / contracts / frontend / backend / security / testing / git
├─ release-manifest.json        # Single expression of cross-repo versions
└─ AGENTS.md                    # Development navigation and hard boundaries (humans and AI agents)
```

## Architecture and Contracts

**Overall architecture diagram**: [`docs/architecture/wasmnest-overall.html`](docs/architecture/wasmnest-overall.html) — an interactive single-file diagram generated by archify; open it in a browser after cloning (on github.com the link only shows the source).

### WIT Source Chain

```text
capability repo wit/core.wit + domain wit/<domain>.wit + wasmnest-contract
        │
        ├─ platform compose.json (declares which fragments this end composes)
        │        └─ node scripts/compose-wit.mjs --all
        ▼
rust/wit/** inside both SDKs (generated, never hand-edited, pinned by drift locks)
```

The contract version is part of the wasm import name. If host and guest versions diverge, instantiation names the missing interface and the version to rebuild — it never degrades silently.

### Cross-repo Versions

`release-manifest.json` validates the platform version, the exact capability-repo HEAD tag, the exact apps-repo HEAD tag, the contract version, both WIT fingerprints and each end's artifact name. The release order is **capability repo → platform repo → apps repo**. Local changes without a tag never enter a release assembly.

### Security Gates

- **Permissions**: nothing is granted by default; undeclared means denied. High-risk surfaces are split by domain (`pty:spawn` / `pty:io`, `ws:client` / `ws:server`, `fs:pick` / `fs:read` / `fs:write`, etc.).
- **Egress**: three-layer decision (target allowlist → declared URL → memory) plus a one-time grant prompt on a miss; headless / test contexts without an `AppHandle` fail closed.
- **Frontend**: Tauri ACL + CSP + static lint form a three-layer blockade; frontend code cannot touch network / file / navigation primitives directly.
- **Error envelope**: cross-process failures use `{ code, request_id, params? }`, where `code` is the frontend i18n key; technical details stay in host logs.

### Tests and Locks

Many design constraints exist as executable locks: zero business types in the host, CSP blockade, command registration completeness, hot-path logging, byte-identical i18n, WIT / permission vocabulary / wire drift, and more. When a lock's allowlist legitimately changes, update it in the same commit; never delete a lock or hollow out its assertions. Cross-end protocol changes must also pass the real interop suite in the test repo.

## Documentation

| Need | Entry point |
| --- | --- |
| Development navigation and hard boundaries | [`AGENTS.md`](AGENTS.md) |
| Code map / task routing / lock index | [`docs/codemap.md`](docs/codemap.md) |
| Full command set | [`docs/commands.md`](docs/commands.md) |
| Architecture and the thin-host boundary | [`docs/architecture.md`](docs/architecture.md) |
| Overall architecture diagram | [`docs/architecture/wasmnest-overall.html`](docs/architecture/wasmnest-overall.html) |
| Plugin / SDK / WIT contracts | [`docs/contracts.md`](docs/contracts.md) |
| Frontend conventions | [`docs/frontend.md`](docs/frontend.md) |
| Rust backend conventions | [`docs/backend.md`](docs/backend.md) |
| Security and logging red lines | [`docs/security.md`](docs/security.md) |
| Testing and definition of done | [`docs/testing.md`](docs/testing.md) |
| Git and cross-repo commit order | [`docs/git.md`](docs/git.md) |
| Dependency direction and forbidden actions | [`docs/boundaries.md`](docs/boundaries.md) |
| Shared conventions across the four repos | [`docs/public/`](docs/public/) |

## Development and Contributing

1. **Read the boundaries first**: [`AGENTS.md`](AGENTS.md) and [`docs/public/`](docs/public/) (git, comments and naming, testing, versioning, issue management). Hard constraints and security red lines are not suggestions.
2. **Commit in small steps**: touch only files the task needs, avoid unrelated refactors, and follow Conventional Commits without AI-generated signatures.
3. **Verify by running**: there is no CI yet; gates are husky pre-commit + local commands + test locks. Skipping a hook does not mean the gate passed — run it manually and report what ran, what did not, and the risk.
4. **Cross-repo changes**: commit and tag in the order capability repo → platform repo → apps repo, then update `release-manifest.json` and run `check:manifest`.
5. **Issues first**: the cross-session backlog lives in [GitHub Issues](https://github.com/7ZAI/wasmnest/issues); bug / feature / contract-change templates are provided in the repo.

## Project Status

- Version line `0.0.1`, early development; interfaces may change destructively.
- Platform tags look like `vX.Y.Z`; capability `lib-vX.Y.Z`, apps `apps-vX.Y.Z`, tests `test-vX.Y.Z`.
- Versions and tags are bumped only for releases; day-to-day development does not bump.
- Roadmap and task backlog are maintained in GitHub Issues.

## License

[MIT](LICENSE) © 2026 7ZAI
