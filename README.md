# Ambient Desktop

Ambient Desktop is a local-first developer workstation where agents do durable, inspectable work on your machine. It combines chat, real workspace context, terminals, browser evidence, source control, artifact previews, and a Project Board so long-running agent work can be paused, reviewed, and resumed.

Ambient Desktop is currently a Developer Preview for macOS, Windows, and Linux.

## Why Ambient Desktop

Most agent tools give you a chat box and a transcript. Ambient Desktop gives you a workspace:

- Project Board: large or ambiguous requests become source-backed cards with evidence, dependencies, and review state.
- Durable goals: long-running work persists its plan, evidence, and continuation state across pauses and restarts.
- Symphony orchestration: parent sessions can delegate scoped work to child agents and join their artifacts back into the result.
- Contained capabilities: risky tools such as MCP servers, scrapers, and Pi packages run behind policy and containment boundaries.
- Provider routing: search, fetch, browser, vision, local, and cloud providers can be prioritized with visible fallback evidence.
- Workflow Recorder: repeated work can be generalized into reviewed, callable workflow artifacts.

## Documentation

The full product and setup documentation lives at [desktop.ambient.xyz](https://desktop.ambient.xyz/).

Start with:

- [Overview](https://desktop.ambient.xyz/)
- [Installation](https://desktop.ambient.xyz/getting-started/installation/)
- [Quickstart](https://desktop.ambient.xyz/getting-started/quickstart/)
- [Security Model](https://desktop.ambient.xyz/security/security-model/)
- [Project Board](https://desktop.ambient.xyz/using-ambient/project-board-kanban/)

## Build From Source

Prerequisites:

- Git
- Node.js
- pnpm
- Platform build tools for native Electron modules

Clone and run in development:

```bash
git clone https://github.com/ambient-xyz/AmbientDesktop.git
cd AmbientDesktop
pnpm install
pnpm run dev
```

To run against a live Ambient provider during development, set the provider and model explicitly before starting the app:

```bash
AMBIENT_PROVIDER=ambient AMBIENT_LIVE_MODEL=example/model-id pnpm run dev
```

The live-provider command may require local credentials. Keep API keys and other secrets in your local credential/configuration flow; do not place them directly in shell history, commits, issues, logs, or artifacts.

Build packaged artifacts on the target platform:

```bash
pnpm run dist:mac
pnpm run dist:win
pnpm run dist:linux
```

Common validation commands:

```bash
pnpm run typecheck
pnpm run docs:build
pnpm run docs:check
```

Many live tests intentionally call real providers and may require local credentials. Do not paste API keys into chat, commits, logs, issues, or artifacts.

## Repository Hygiene

This public repository is intended to start from a clean source snapshot with no private Git history. Runtime state, local credentials, release artifacts, and dogfood outputs should stay ignored.

Before publishing a public snapshot, verify that no ignored key files, `.env` files, local Ambient state, browser credentials, or secret-bearing artifacts are present.

## Credits

Ambient Desktop builds on several open-source systems, including Pi Agent, Lambda-RLM, ToolHive, and TencentDB Agent Memory. In-app acknowledgements and license notices are available under Settings -> About.

## License

Ambient Desktop is licensed under the MIT License. See [LICENSE](LICENSE).
