# Production Security Review Plan

This document tracks the pre-production security review for Ambient Desktop. The review is launch-oriented: it prioritizes exploit chains that can cross from untrusted content, agent behavior, plugins, or local files into privileged desktop capabilities.

## Scope

Review the current Ambient Desktop repository as an Electron/Vite desktop app with:

- React renderer, preload IPC bridge, and privileged Electron main process.
- Local filesystem, git, terminal, native module, Docker, and sandbox execution.
- Ambient/Pi agent loops, streaming provider calls, workflow agents, and tool calls.
- Codex plugins, Pi extension packages, MCP runtimes, marketplaces, and dependency installation.
- Browser automation, managed browser credentials, OAuth, Google Workspace, STT/TTS, MiniCPM vision, Office preview, generated artifacts, logs, transcripts, and updates.

## Review Principles

- Validate product behavior with live Ambient/Pi paths where it matters, not only mocks.
- Prefer clearer Pi inputs, contracts, schemas, and permissions over post-processing Pi output.
- Keep secrets out of chat, tool args, logs, descriptors, artifacts, and Pi-visible output.
- Use Ambient-managed secret flows for cloud/API provider secrets.
- Preserve full large tool outputs in bounded artifacts, with only bounded previews in model context.
- Do not add, modify, enable, or rely on cloud GitHub Actions workflows for this review.
- Confirm exploitability with local tests or targeted live dogfood before treating a finding as launch-blocking.

## Primary Threat Model

The highest-risk chains to evaluate first are:

- Prompt injection or hostile tool output causes malicious rendered content, which reaches the broad preload IPC surface and triggers privileged filesystem, shell, plugin, git, credential, or update actions.
- Malicious workspace content, plugin metadata, MCP tool output, or generated artifacts influences Pi into excessive-agency actions or secret disclosure.
- A plugin, Pi extension, MCP runtime, Docker container, or sandbox bridge escapes intended workspace or network boundaries.
- Local state tampering bypasses plugin trust, permission grants, OAuth/account state, or audit trails.
- Auto-update, package install, dependency install, or marketplace import delivers untrusted code into privileged execution.

## Framework Use

Use these as active review drivers:

- Electron Security Checklist: renderer isolation, preload design, navigation, permission, protocol, and external URL controls.
- OWASP Top 10 for LLM Applications 2025: prompt injection, insecure output handling, sensitive disclosure, supply chain, excessive agency, and plugin design.
- OWASP AISVS: agentic action controls, MCP/tool governance, privacy, monitoring, and human oversight.
- STRIDE: threat modeling for renderer, main, plugins, tools, local state, and network boundaries.
- MITRE ATT&CK and MITRE ATLAS: realistic desktop, credential, persistence, exfiltration, and AI-agent adversary techniques.

Use these as targeted references, not broad checklists:

- OWASP ASVS and WSTG for renderer, OAuth, local HTTP callback, browser-like, and web-content surfaces.
- OWASP risk rating and CVSS-style scoring for severity normalization.

Use these for release and supply-chain gates:

- NIST SSDF SP 800-218, SLSA, OpenSSF Scorecard, and OWASP SCVS for build integrity, dependency provenance, vulnerability handling, release process, and post-launch maturity.

## Phase 0: Baseline Automated Checks

Status: Initial pass complete on 2026-05-14

Run these before deep manual review so obvious structural issues and known CVEs are visible:

- `pnpm run typecheck`
- `pnpm test`
- Focused security-adjacent tests around permissions, plugins, browser, workflow tools, and sandboxing.
- `pnpm audit` or equivalent dependency audit.
- Secret scan with local tooling such as `gitleaks` or `trufflehog` if available.
- Semgrep or equivalent TypeScript/Electron security rules.
- Electron-specific static checks where available.
- Lockfile review for unexpected native packages, lifecycle scripts, git dependencies, tarball URLs, and package manager overrides.

Expected evidence:

- Command output summary with date, git SHA, pass/fail, and artifact paths.
- List of automated findings promoted for manual verification.

## Phase 1: Asset Inventory And Trust Boundaries

Status: Initial pass complete on 2026-05-14

Build an attack-surface map from source, scripts, docs, build config, package metadata, and tests.

Track assets:

- Ambient API keys, cloud provider API keys, OAuth tokens, refresh tokens, browser credentials, cookies, and session state.
- User workspace files, local git remotes, worktrees, generated artifacts, logs, transcripts, screenshots, audio/video, Office previews, and databases.
- Plugin packages, Pi extension packages, MCP runtime state, marketplace metadata, and installer outputs.
- Update artifacts, release config, entitlements, native modules, packaged resources, and local sidecars.

Track boundaries:

- Renderer to preload to main process.
- Workspace-controlled files to privileged app process.
- Pi/Ambient cloud responses to local tool execution.
- Plugin/MCP/package code to Ambient host.
- Browser automation to authenticated sites and local callbacks.
- Update server to installed desktop binary.

Expected evidence:

- Attack-surface notes with entrypoints, assets, and trust boundaries.
- Initial list of security-critical files and handlers.

## Phase 2: Preload And IPC Authority Review

Status: Initial pass complete on 2026-05-14

Enumerate every preload method and every `ipcMain.handle` path. Classify each by authority:

- Secrets and credentials.
- Filesystem read/write/delete/open/reveal.
- Shell, terminal, native execution, Docker, and sandbox operations.
- Git destructive or remote actions.
- Plugin, package, dependency, and marketplace actions.
- Browser automation and credential actions.
- Permission grants, prompts, audit, and local state mutation.
- Updates, release checks, and external URL opening.

For every high-authority handler, verify:

- Input schema validation with explicit bounds.
- Sender, window, and lifecycle validation.
- Authorization and permission checks at the main-process boundary.
- Path normalization, symlink handling, and workspace confinement where expected.
- Safe error handling and secret redaction.
- Return shapes do not expose raw secrets, absolute sensitive paths, or excessive output.
- Approval decisions bind to immutable command/file/action payloads.

Expected evidence:

- IPC inventory table with handler, authority, validation, permission, and risk notes.
- Launch-blocking gaps for any unauthenticated or weakly validated privileged handler.

## Phase 3: Electron Hardening

Status: Initial pass complete on 2026-05-14

Review all Electron windows, views, sessions, protocols, permissions, navigation, and external URL handling.

Verify:

- `contextIsolation`, `sandbox`, `nodeIntegration: false`, and `webSecurity` on every renderer or web content surface.
- No remote content receives privileged preload APIs.
- Navigation, redirects, `window.open`, custom schemes, `file:`, `javascript:`, and `shell.openExternal` are constrained.
- Permission request handlers deny by default and scope grants clearly.
- Custom protocols do not expose arbitrary local files or bypass CSP.
- Dev-only behavior is absent from production builds.

Dedicated launch-risk review:

- Justify or remove macOS entitlements: `allow-jit`, `allow-unsigned-executable-memory`, and `disable-library-validation`.
- Verify packaged app behavior matches development assumptions.
- Confirm code signing, notarization expectations, hardened runtime, and native module packaging.

Expected evidence:

- Window/session/protocol inventory.
- Entitlement justification or remediation list.
- Packaged-app verification notes.

## Phase 4: Rendered Content, CSP, And XSS Chains

Status: Initial pass complete on 2026-05-14

This is a primary launch-blocking area because the app renders LLM output, tool output, artifacts, Office previews, media, plugin metadata, and browser-like content.

Review:

- Renderer CSP, especially `script-src 'unsafe-inline'`, `style-src 'unsafe-inline'`, `frame-src`, `img-src file:`, `media-src`, and localhost/websocket allowances.
- Markdown, HTML, diff, log, transcript, Office, artifact, plugin, and MCP output rendering.
- React escape boundaries, `dangerouslySetInnerHTML`, iframe sandboxing, media URL generation, custom protocol handlers, and artifact preview isolation.
- Whether XSS can reach `window.ambientDesktop` and invoke privileged APIs.

Required tests:

- Prompt injection emits hostile markdown/HTML with script tags, event handlers, SVG/script payloads, iframe payloads, and link payloads.
- Hostile artifact preview attempts to invoke preload APIs.
- Tool output includes malicious HTML, terminal escape/control sequences, and oversized content.
- Malicious plugin metadata renders in settings or marketplace screens.

Expected evidence:

- List of every untrusted rendering path and its sanitizer/isolation strategy.
- Proof that hostile rendered content cannot invoke privileged APIs.

## Phase 5: Secrets, Credentials, Privacy, And Retention

Status: Initial pass complete on 2026-05-14

Trace secret and personal data lifecycle end to end:

- Ambient API keys, provider API keys, OAuth tokens, browser credentials, cookies, secure inputs, Google Workspace data, STT/TTS audio/transcripts, screenshots, Office previews, logs, and artifacts.

Verify:

- Storage location and file permissions.
- Redaction from logs, errors, transcripts, artifacts, model-visible context, and crash paths.
- No secret values in IPC return payloads unless explicitly required and protected.
- Secret prompt flows use Ambient-managed secret request or env bind paths.
- Token refresh, revoke, reconnect, account identity, scope minimization, and disconnect behavior.
- Retention defaults for audio, video, screenshots, documents, transcripts, and connector data.
- Privacy expectations for GDPR/CCPA-style user data rights, deletion, and export where applicable.

Expected evidence:

- Secret/data flow map.
- Redaction test results.
- Retention and deletion gap list.

## Phase 6: Agentic Pi, Workflow, Tool, Plugin, MCP, And Package Execution

Status: Initial pass complete on 2026-05-14

Review all non-core or autonomous execution surfaces as one permission and sandbox model:

- Pi tool calls and post-tool transcript handling.
- Workflow agents and generated workflow artifacts.
- Codex plugin install/import/trust/enable flows.
- Pi extension sandbox and privileged fallback flows.
- MCP runtime startup, tool descriptors, output handling, and shutdown.
- Capability builder and provider onboarding flows.

Verify:

- Tool descriptors carry side-effect metadata, permission scope, dry-run support, timeouts, idempotency guidance, and schema validation.
- Permission grants are scoped, expiring where appropriate, auditable, revocable, and not bypassable by local state tampering.
- Prompt injection in repository files, plugin metadata, MCP output, and tool output cannot grant itself authority.
- Privileged package paths stay disabled until explicit review and user action.
- Installers do not ask users to paste secrets into chat or expose secret values to Pi.
- Large outputs write full artifacts and return bounded previews.
- Agent loops have cancellation, timeout, spend, and runaway execution controls.

Required tests:

- Malicious repo file instructs Pi to exfiltrate secrets or bypass policy.
- Malicious plugin package declares misleading safe metadata while attempting filesystem, network, or shell actions.
- MCP tool returns prompt-injection content that asks Pi to change permissions or reveal secrets.
- Pi extension sandbox failure routes to privileged review without silently enabling privileged execution.
- Emergency stop and cancellation halt active tool/model loops.

Expected evidence:

- Unified permission/sandbox matrix for tools, workflows, plugins, and MCP.
- Live Ambient/Pi dogfood runs for high-risk behaviors.

## Phase 7: Filesystem, Git, Shell, Native, Docker, And Sandbox Boundaries

Status: Initial pass complete on 2026-05-14

Review local authority paths:

- File read/write/delete/open/reveal and workspace search.
- Git status, branch, stage, discard, commit, push, pull, worktrees, PR URL creation, and board artifact sync.
- Terminal and `node-pty`.
- `execFile`, `spawn`, native modules, local sidecars, Docker, `dockerode`, and agent-os sandbox.

Verify:

- Workspace confinement handles absolute paths, `..`, symlinks, hardlinks, case variants, Windows paths, newline filenames, long paths, and Unicode normalization.
- Destructive actions require precise review and immutable approval payloads.
- Commands use safe argv arrays, bounded environment, safe cwd, and no shell interpolation unless explicitly reviewed.
- Docker socket access is not exposed to agents, plugins, MCP tools, or sandboxed code unless deliberately privileged and reviewed.
- Network-disabled sandbox paths actually block network egress.
- Full stdout/stderr is preserved to artifacts without secret leakage to Pi-visible previews.

Required tests:

- Attempt reads of `~/.ssh/id_rsa`, shell history, credential stores, and files outside workspace.
- Symlink inside workspace points outside workspace, then file APIs and git/artifact import try to follow it.
- Docker socket abuse attempts host-root mount.
- TOCTOU test mutates approved command/file action before execution.
- Giant output and binary output tests verify artifact preservation and redaction.

Expected evidence:

- Workspace escape test matrix.
- Docker and sandbox boundary notes.
- Command execution review notes.

## Phase 8: Browser Automation, OAuth, And Localhost Surfaces

Status: Initial pass complete on 2026-05-14

Review:

- Internal browser host, WebContentsView, managed Chrome/profile copy behavior, browser credentials, browser reveal/pick/navigate/content/key APIs, and injected JavaScript.
- OAuth client import, local callback handling, token storage, scope validation, account identity, disconnect/revoke, and error handling.
- Local HTTP and websocket surfaces allowed by CSP or app callbacks.

Verify:

- Browser automation cannot read or expose unrelated cookies/passwords/sessions.
- Hostile redirects, local callbacks, `javascript:` URLs, custom schemes, file URLs, and localhost SSRF-style requests are blocked or scoped.
- OAuth state/PKCE/redirect validation resists CSRF and account substitution.
- Stored browser credentials are not exposed to renderer, Pi, logs, or artifacts except through explicit safe flows.

Required tests:

- Browser automation credential theft attempt.
- OAuth redirect/account substitution attempt.
- Hostile URL and redirect navigation attempts.
- Localhost callback collision or spoof attempt.

Expected evidence:

- Browser/OAuth threat notes and test results.
- Credential handling gap list.

## Phase 9: Network, Ambient/Pi Streaming, Updates, And Release Integrity

Status: Initial pass complete on 2026-05-14

Review:

- Ambient/Pi API calls, sessions, streaming timeout phases, retries, error handling, and request/response logging.
- TLS assumptions, endpoint allowlists, local port exposure, proxy behavior, and offline/failure behavior.
- `electron-updater` generic provider configuration, update signing/integrity, rollback, downgrade, release env handling, and packaged contents.
- Build scripts, native rebuilds, sidecar resources, `asarUnpack`, and release artifacts.

Verify:

- Pre-stream response timeout and stream-idle timeout are distinct and reset on valid stream activity.
- Model/provider errors do not leak secrets.
- Updates cannot be spoofed, downgraded, or swapped without signature/integrity failure.
- Packaged app contains only intended resources and no local secret files.

Expected evidence:

- Network/update threat notes.
- Packaged artifact inspection summary.
- Release-blocking update or signing gaps.

## Phase 10: Targeted Exploit-Chain Validation

Status: Local repro release gate complete; targeted manual/E2E expansion remains useful for future release hardening.

Run focused end-to-end tests after manual review identifies the riskiest seams:

- Prompt injection to rendered XSS to IPC privilege attempt.
- Malicious plugin install to shell/filesystem/network attempt.
- MCP prompt-injection output to permission escalation attempt.
- Workspace path escape to secret read attempt.
- Browser automation to credential/session disclosure attempt.
- Docker/sandbox escape attempt.
- Local DB tampering to permission/trust bypass attempt.
- Update/package integrity tampering attempt where feasible locally.

Expected evidence:

- Reproduction steps, observed result, and pass/fail for each chain.
- Fix verification for any confirmed issue.

## Severity And Launch Gates

Use this launch gate:

- Critical: exploitable RCE, secret exfiltration, unauthorized shell/filesystem access outside expected user approval, update compromise, or silent privileged plugin/tool enablement. Must fix before production.
- High: reliable permission bypass, credential exposure to Pi/renderer/logs, sandbox escape, OAuth account substitution, or destructive action without exact approval. Must fix before production unless explicitly accepted by leadership.
- Medium: defense gap with limited exploitability, missing audit evidence, weak retention controls, or non-blocking dependency risk. Fix before launch when practical, otherwise track with owner and deadline.
- Low: hardening, documentation, observability, and process improvements with no clear immediate exploit path. Track post-launch if needed.

Launch is blocked if:

- Any Critical finding remains open.
- Any High finding remains open without explicit risk acceptance.
- The XSS to privileged IPC chain is not tested.
- Secret redaction and storage paths are not verified.
- Plugin/MCP/Pi privileged execution paths are not tested.
- Update integrity/signing assumptions are not documented.

## Finding Template

Use this format for each confirmed issue:

```markdown
## [Severity] Short Title

- Status:
- Owner:
- Affected files:
- Framework mapping:
- Asset at risk:
- Exploit path:
- Evidence:
- Reproduction:
- Recommended fix:
- Verification:
- Residual risk:
```

## Execution Log

### 2026-05-14 Initial Review Pass

- Git SHA: `b7b3aed9da5acfebf7deb1ab57c44feca9fc375d`.
- Local toolchain: Node `v20.20.0`, pnpm `10.13.1`.
- Worktree note: `docs/production-security-review-plan.md` is untracked review output.
- Source/config/doc inventory: approximately 690 files in review scope.
- `pnpm run typecheck`: passed.
- `pnpm test`: failed in this checkout because the local Node runtime is incompatible with the currently built native modules. `better-sqlite3` was built for a different Node module ABI, and `@rivet-dev/agent-os-core` imports `node:sqlite`, which is unavailable in this local Node 20 run.
- Focused native wrapper tests passed: `bash scripts/test-node-native.sh src/main/permissionPolicy.test.ts src/main/permissionGrants.test.ts src/main/permissionPrompts.test.ts src/main/diagnostics.test.ts src/main/browserCredentialStore.test.ts src/main/browserService.test.ts src/main/ambientCliPackages.test.ts src/main/piPrivilegedPackages.test.ts src/main/plannerDurableHtml.test.ts src/main/workflowDesktopTools.test.ts src/main/agentBootstrapContext.test.ts src/main/workflowCompiler.test.ts src/main/workflowConnectors.test.ts` passed 13 files, 223 tests, 8 skipped.
- Focused plugin/update/browser tests passed: `pnpm exec vitest run src/main/codexPlugins.test.ts src/main/piPrivilegedPackages.test.ts src/main/browserCredentialStore.test.ts src/main/browserService.test.ts src/main/updateService.test.ts src/main/updaterBootstrapPolicy.test.ts` passed 6 files, 94 tests, 5 skipped.
- Workflow loader rejection tests passed: `pnpm exec vitest run src/main/workflowProgramLoader.test.ts -t "rejects"` passed 1 file, 2 tests, 3 skipped.
- `pnpm audit --prod`: failed with four advisories: high `fast-xml-builder <=1.1.6` via `@mariozechner/pi-ai > @aws-sdk/client-bedrock-runtime`; moderate `@anthropic-ai/sdk >=0.79.0 <0.91.1`; moderate `fast-xml-builder =1.1.5`; low `elliptic <=6.6.1` via `@rivet-dev/agent-os-core`.
- Secret/static tools: `gitleaks`, `trufflehog`, `semgrep`, and `electronegativity` were not installed locally. Filename scan found no obvious tracked secret files; `.gitignore` covers local key files such as `ignored-provider-key-file.txt`, provider key files, and Telegram credential files.
- Independent Ambient second opinion: attempted against a tracked-file snapshot at `/tmp/ambient-security-review.3GvcXE` to avoid exposing ignored local secrets. The run did not complete because the Ambient API returned quota exhaustion (`HTTP 402`). Treat this as a blocked validation step, not as independent confirmation.
- Independent Gemini repo-verify: completed against clean tracked snapshot `/private/tmp/ambient-gemini-security.dntQWz` generated from the same HEAD. The first attempt was stopped because the helper included the live working tree by default; the completed run used the snapshot as `cwd` so ignored local secrets were out of scope. Gemini reported four repo-grounded findings. One overlaps F-006; three new concrete IPC chains were verified locally and recorded as F-013 through F-015. Gemini also attempted one invalid grep and one disallowed shell tool call during the run; those tool errors did not affect the locally verified findings.
- Local symlink proof: a workspace symlink to a file outside the workspace passed lexical containment and `stat`/`open` followed it, returning the sentinel content. This confirms the workspace preview symlink issue below.

## Initial Findings

### F-001 Critical: Workspace-Stored Provider Secrets Are Agent-Readable

- Status: Not reproduced after Phase 1D.
- Owner: Ambient Desktop.
- Affected files: `src/main/ambientCliPackages.ts`, `src/main/capabilityBuilder.ts`, `src/main/permissionPolicy.ts`, `src/main/toolRunner.ts`.
- Framework mapping: OWASP LLM Top 10 sensitive information disclosure and excessive agency; Electron local file authority; STRIDE information disclosure and elevation of privilege.
- Asset at risk: cloud/API provider keys saved through Ambient-managed secret flows.
- Exploit path: Ambient CLI and Capability Builder secrets are stored as plaintext `*.secret` files under workspace-local `.ambient/.../secrets`. The permission policy's file-tool secret patterns do not match `*.secret`, and bash path extraction ignores relative paths such as `.ambient/cli-packages/secrets/...`. In workspace mode, Pi can read or print these files with `file_read` or `bash` and receive the content in transcript/tool output.
- Evidence: `src/main/ambientCliPackages.ts:1308-1315` writes Ambient CLI secrets under `.ambient/cli-packages/secrets`; `src/main/capabilityBuilder.ts:1162-1170` writes Capability Builder secrets under `.ambient/capability-builder/secrets`; `src/main/permissionPolicy.ts:44-48` only flags a narrow set of secret-like names; `src/main/permissionPolicy.ts:248-266` allows inside-workspace file reads unless the path matches those patterns; `src/main/permissionPolicy.ts:852-857` only extracts shell path candidates beginning `../`, `/`, or `~/`; `src/main/permissionPolicy.ts:314` allows non-network, non-dangerous bash commands.
- Reproduction: After saving a provider secret, ask the agent to read `.ambient/cli-packages/secrets/<package>/<ENV>.secret` or run `cat .ambient/cli-packages/secrets/<package>/<ENV>.secret` in workspace mode.
- Recommended fix: Move secret material out of the agent-writable workspace into OS/app-managed secure storage, keyed by workspace and package identity. If file-backed bindings remain, store only non-secret references in the workspace and resolve values in main process immediately before approved command execution. Add deny rules for `.ambient/**/secrets/**`, `*.secret`, and all secret binding paths to file tools, shell policy, search, previews, and artifacts.
- Verification: Regression coverage and the local repro gate prove managed secret files are no longer written to workspace-local secret paths, legacy secret paths are denied, and Pi-visible outputs pass through the redaction boundary.
- Residual risk: Even after moving current secrets, historical `.ambient/**/secrets/**` files may remain in user workspaces and need migration/deletion guidance.

### F-002 Critical: Ambient API Key And Process Environment Leak To Agent/Tool Processes

- Status: Not reproduced after Phase 1D.
- Owner: Ambient Desktop.
- Affected files: `src/main/credentialStore.ts`, `src/main/agentRuntime.ts`, `src/main/toolRunner.ts`, `src/main/runtimePath.ts`, `src/main/ambientCliPackages.ts`, `src/main/toolOutputArtifacts.ts`.
- Framework mapping: OWASP LLM Top 10 sensitive information disclosure; STRIDE information disclosure.
- Asset at risk: Ambient API key and any other process environment secrets.
- Exploit path: The saved Ambient API key is copied into `process.env.AMBIENT_API_KEY`. Pi bash/tool execution and Ambient CLI command execution inherit `process.env`. Their stdout/stderr are returned directly or materialized to workspace artifacts without redaction. A simple `env`, `printenv`, or failing command can expose secrets to Pi-visible output.
- Evidence: `src/main/credentialStore.ts:27-30` and `src/main/credentialStore.ts:49` put the Ambient key into `process.env`; `src/main/agentRuntime.ts:2999-3001` primes that environment during session setup; `src/main/toolRunner.ts:101-106` copies all `process.env` into tool invocations; `src/main/runtimePath.ts:17-22` defaults `ambientRuntimeEnv()` to all of `process.env`; `src/main/ambientCliPackages.ts:1159-1166` uses that env for Ambient CLI commands; `src/main/workflowDesktopTools.ts:485-504` and `src/main/toolOutputArtifacts.ts:13-38` return or store output with no secret redaction.
- Reproduction: In workspace mode, run a benign environment-printing command through the agent shell or an Ambient CLI package command and inspect the returned output.
- Recommended fix: Stop storing provider credentials in global `process.env`. Build explicit, minimal child-process env maps per capability. Pass the Ambient API key only to the Ambient client path that needs it, not to generic shell/plugin/CLI/workflow processes. Add centralized output redaction for known secret values and high-risk env key patterns before any Pi-visible preview, transcript, log, or artifact.
- Verification: Regression coverage and the local repro gate prove saved Ambient keys are not written into global process env, broad child-process env inheritance is removed from generic tool paths, and Pi-visible stdout/stderr/artifacts are redacted.
- Residual risk: Third-party tools may intentionally print their env; command-level least-privilege env is still required even with redaction.

### F-003 Critical: Workspace-Writable Authority State Enables Permission, Trust, And Audit Tampering

- Status: Not reproduced after Phase 2A.
- Owner: Ambient Desktop.
- Affected files: `src/main/projectStore.ts`, `src/main/toolRunner.ts`, `src/main/permissionPolicy.ts`.
- Framework mapping: STRIDE tampering/elevation of privilege; OWASP LLM excessive agency; Electron local state integrity.
- Asset at risk: permission mode, grants, audit, plugin trust/enabled state, workflow state, browser credential metadata, and app control state.
- Exploit path: Ambient stores `state.sqlite` under the user workspace's `.ambient-codex` directory. Workspace-mode tools can write the whole workspace, and on current macOS shell commands fall back to policy-only containment. The permission policy does not prompt for relative `.ambient-codex/...` shell paths. A malicious or prompt-injected agent can modify the SQLite state to flip threads to `full-access`, insert permission grants, trust plugins, or alter audit/history.
- Evidence: `src/main/projectStore.ts:2842-2850` creates `.ambient-codex/state.sqlite` inside the workspace; `src/main/projectStore.ts:9484-9494` stores `threads.permission_mode`; `src/main/projectStore.ts:9571-9607` stores permission audit and grants; `src/main/projectStore.ts:9829-9838` stores plugin settings/trust; `src/main/toolRunner.ts:411-414` allows workspace reads/writes in the macOS sandbox profile; `src/main/toolRunner.ts:440-447` falls shell execution back to policy-only on macOS; `src/main/permissionPolicy.ts:852-857` misses `.ambient-codex/...` relative paths.
- Reproduction: In a test workspace, run a local script that opens `.ambient-codex/state.sqlite` and updates `threads.permission_mode` or inserts a permission grant.
- Recommended fix: Move authority-bearing app state out of the agent-writable workspace into app-managed `userData`, keyed by workspace identity. Keep only non-authoritative artifacts in `.ambient-codex`, or make the whole authority subtree inaccessible to file tools, shell, plugin runtimes, previews, and search. Add state integrity checks and tamper-evident audit where practical.
- Verification: Regression coverage and the local repro gate prove authority state is resolved through app-managed paths and legacy workspace authority paths are denied to tools.
- Residual risk: Existing workspaces will already contain authority state and need migration plus stale-file cleanup.

### F-004 High: Browser Credential Metadata Can Be Tampered From The Workspace

- Status: Not reproduced after Phase 2B.
- Owner: Ambient Desktop.
- Affected files: `src/main/browserCredentialStore.ts`, `src/main/projectStore.ts`, `src/main/agentRuntime.ts`, `src/main/browserService.ts`.
- Framework mapping: OWASP sensitive information disclosure; STRIDE tampering/spoofing.
- Asset at risk: stored browser passwords.
- Exploit path: Browser credential records live under `.ambient-codex/browser/credentials.json`. The password is encrypted, but label, username, and origin are unsigned mutable JSON. An agent that can write workspace state can preserve an encrypted password while changing its origin to an attacker-controlled site. Later `browser_login` compares the requested origin, credential origin, and current page origin, but all three can align to the tampered origin, subject to the user approving the prompt.
- Evidence: `src/main/browserCredentialStore.ts:54-64` stores mutable origin/metadata next to encrypted password; `src/main/browserCredentialStore.ts:87-94` decrypts and returns the record's current origin; `src/main/browserCredentialStore.ts:130` stores the file under `workspace.statePath`; `src/main/projectStore.ts:2842-2850` puts `statePath` in `.ambient-codex`; `src/main/agentRuntime.ts:10783-10791` resolves the credential and uses the model-supplied expected origin; `src/main/browserService.ts:1883-1895` checks only equality among expected, credential, and current origins.
- Reproduction: Save a test credential, modify `.ambient-codex/browser/credentials.json` to change its origin, navigate the browser to that origin, then call `browser_login` with the same credential id and modified origin.
- Recommended fix: Move browser credential records to app-managed storage; bind encrypted password material cryptographically to immutable origin and account metadata; require re-entry or explicit migration if origin changes; include origin in the authenticated encryption payload where possible.
- Verification: Regression coverage and the local repro gate prove credential metadata is integrity-bound inside the encrypted payload and legacy workspace credential paths are denied.
- Residual risk: User approval remains a control, but the prompt can be misleading if the metadata source is already compromised.

### F-005 High: Workspace File Preview And Media Serving Follow Symlinks Outside The Workspace

- Status: Not reproduced after Phase 3B; launch-blocking product surfaces are closed.
- Owner: Ambient Desktop.
- Affected files: `src/main/workspacePathResolver.ts`, `src/main/workspaceFiles.ts`, `src/main/workspaceMedia.ts`, `src/main/piReadOperations.ts`, `src/main/agentRuntime.ts`, `src/main/index.ts`.
- Framework mapping: Electron filesystem confinement; STRIDE information disclosure/tampering.
- Asset at risk: local files outside the selected workspace.
- Exploit path: `resolveWorkspacePath()` performs lexical path containment only. `stat()`, `open()`, `writeFile()`, and media serving then follow symlinks. A hostile repository can include a symlink such as `secrets.txt -> ~/.ssh/id_rsa`; preview/open/media paths treat it as inside the workspace and read or stream the target.
- Original evidence: `workspaceFiles`, workspace media serving, and open/reveal IPC used lexical workspace containment before filesystem operations that could follow symlinks.
- Remediation evidence: Phase 3A added shared `lstat`/`realpath` resolver checks plus no-follow file opens for preview, read, write, media, context, and artifact paths. Phase 3B routes Pi native `read`, `write`, `edit`, `grep`, `find`, and `ls` operations plus workspace open/reveal and file-list metadata through the same boundary.
- Reproduction: Local proof created a temp workspace symlink to an outside sentinel file; the same lexical check passed and `stat`/`open` read `SECRET_SENTINEL`.
- Recommended fix: Use `lstat` and `realpath` for every workspace read/write/open/media path. Reject symlinks by default or prompt if their real target is outside the workspace. Mark symlinks distinctly in file lists. Use no-follow/open-safe semantics where available.
- Verification: Symlink matrix coverage now spans file preview, media preview, write, reveal/open, context references, Pi search/list/read/write/edit tools, file-list metadata, and media token swaps. Local F-005 repro returns `not-reproduced`.
- Residual risk: Hardlinks, mount points, platform-specific canonicalization, and a dirfd/openat-style parent-directory race harness remain defense-in-depth targets.

### F-006 High: Main Renderer Is Unsandboxed Despite A Very Broad Privileged IPC Bridge

- Status: Not reproduced after Phase 5C.
- Owner: Ambient Desktop.
- Affected files: `src/main/index.ts`, `src/preload/index.ts`.
- Framework mapping: Electron Security Checklist; STRIDE elevation of privilege.
- Asset at risk: all renderer-reachable desktop authority.
- Exploit path: The main BrowserWindow has `contextIsolation: true` and `nodeIntegration: false`, but `sandbox: false`. The preload exposes 260 unique privileged `ipcRenderer.invoke` methods, including filesystem, git, plugin install/trust, credential, browser, terminal, secret, and update actions. Any renderer compromise can call the preload API surface; disabling Chromium sandbox increases the blast radius of renderer bugs.
- Evidence: `src/main/index.ts:4624-4629` sets `sandbox: false`; static inventory counted 260 unique preload invokes and 260 matching main handlers; `src/preload/index.ts:245-418` includes clipboard, API key, workspace file, git, plugin dependency, Pi privileged install, browser credential/profile, secure input, ambient CLI secret, terminal, permission, and update methods.
- Reproduction: Renderer XSS or malicious local content with access to `window.ambientDesktop` can attempt high-authority API calls.
- Recommended fix: Enable renderer sandbox if compatible; reduce the preload surface; split high-risk operations behind sender/window validation and main-process permission gates; make renderer compromise a contained event rather than a full app-authority bridge.
- Verification: Static regression coverage and the local repro gate prove the main renderer sandbox is enabled and IPC handlers route through trusted sender/frame validation.
- Residual risk: Preload APIs are still privileged even with renderer sandbox; least-authority IPC design remains necessary.

### F-007 High: Default Permission Mode Is Full Access

- Status: Not reproduced after Phase 5A.
- Owner: Ambient Desktop.
- Affected files: `src/main/projectStore.ts`, `src/main/index.ts`.
- Framework mapping: OWASP LLM excessive agency; STRIDE elevation of privilege.
- Asset at risk: filesystem, shell, plugin/package install, browser, and workflow authority.
- Exploit path: New default settings and thread rows use `full-access`, which bypasses workspace permission checks. Full access also auto-allows some privileged package install flows. A prompt-injected repo or model mistake starts from maximum local authority unless the user changes settings.
- Evidence: `src/main/projectStore.ts:2881-2884` defaults `permissionMode` to `full-access`; `src/main/projectStore.ts:9492` sets the thread schema default to `full-access`; `src/main/index.ts:7141-7148` auto-allows Pi privileged install when the thread is full-access.
- Reproduction: Create a new workspace/thread and inspect the default permission mode.
- Recommended fix: Default to workspace mode with explicit onboarding copy for full access. Require fresh user intent for privileged install, browser credential fill, and state/trust mutation even in full-access mode.
- Verification: Regression coverage and the local repro gate prove full-access is no longer the default permission mode.
- Residual risk: Power users may still opt into full access; logs and warnings should make that state visible.

### F-008 Medium: External URL And Window Open Handling Allows `file:` And Unvalidated Targets

- Status: Not reproduced after Phase 5A.
- Owner: Ambient Desktop.
- Affected files: `src/main/index.ts`, `src/main/internalBrowserHost.ts`.
- Framework mapping: Electron navigation/external URL controls; STRIDE spoofing/elevation of privilege.
- Asset at risk: local apps/files and user trust in external navigation.
- Exploit path: Renderer `window.open` handlers pass arbitrary URLs to `shell.openExternal()`, and the explicit `links:open-external` schema allows `file:` URLs. Internal browser popup handling loads the target URL directly into the WebContentsView without a scheme allowlist.
- Evidence: `src/main/index.ts:968-975` permits `file:` in `externalUrlSchema`; `src/main/index.ts:4636-4638` and `src/main/index.ts:5270-5272` call `shell.openExternal(url)` without validation; `src/main/index.ts:6464-6470` exposes the IPC path; `src/main/internalBrowserHost.ts:271-279` loads popup URLs directly.
- Reproduction: Trigger a renderer link or IPC call with a `file:` URL or unexpected scheme and observe external opening/loading.
- Recommended fix: Restrict external open to `https:` and carefully selected `http:` domains. Route local file reveal/open through separate explicit local-file APIs with clear user intent. Add scheme allowlists to internal browser popup handling and navigation.
- Verification: URL policy regression coverage and the local repro gate prove external opens and internal-browser popup/navigation paths reject unsafe schemes.
- Residual risk: Some workflows may intentionally need local file opening; keep that path explicit and auditable.

### F-009 Medium: Workflow VM Runtime Limits Do Not Stop Synchronous CPU Loops

- Status: Not reproduced after Phase 6E.
- Owner: Ambient Desktop.
- Affected files: `src/main/workflowProgramLoader.ts`, `src/main/workflowSourceValidation.ts`, `src/main/workflowRunService.ts`.
- Framework mapping: OWASP LLM excessive agency and availability; STRIDE denial of service.
- Asset at risk: Electron main process availability.
- Exploit path: Workflow source is loaded with a `vm.Script` timeout, but the exported `run` function is later called directly and can execute synchronous CPU loops outside a VM timeout. Source validation blocks `while(true)` and `for(;;)` only, which is easy to bypass with variants such as `while (1)`.
- Evidence: `src/main/workflowProgramLoader.ts:43-52` applies timeout only to initial script evaluation and then calls `run` directly; `src/main/workflowSourceValidation.ts:37-38` only blocks two unbounded loop patterns; `src/main/workflowRunService.ts:254-256` executes the loaded workflow in the main runtime path.
- Reproduction: Compile or manually create a workflow artifact whose `run` contains a bypassed synchronous loop. Do not run this in a normal app session without a watchdog because it can hang the process.
- Recommended fix: Execute generated workflow code in a worker process/thread or sandbox with an enforceable kill boundary. Treat regex loop detection as advisory, not a security control.
- Verification: VM timeout and async-continuation regression coverage plus `pnpm run test:workflow-hard-kill-gate` prove synchronous and post-await generated-code loops reject in a child process, and that the parent can escalate a SIGTERM-resistant child to `SIGKILL`.
- Residual risk: Product workflow execution still uses the VM timeout and async continuation guards rather than a full least-authority RPC worker bridge. The local release gate now covers the OS hard-kill proof for F-009; a product worker bridge remains optional defense-in-depth.

### F-010 Medium: Renderer CSP And HTML Preview Remain Loose

- Status: Not reproduced after Phase 5B.
- Owner: Ambient Desktop.
- Affected files: `src/renderer/index.html`, `src/renderer/src/App.tsx`.
- Framework mapping: Electron Security Checklist; OWASP insecure output handling.
- Asset at risk: renderer integrity and privileged preload API surface.
- Exploit path: The renderer CSP allows `script-src 'unsafe-inline'`. Workflow HTML previews use a fully sandboxed iframe, but file HTML previews use `sandbox="allow-scripts"` with raw `srcDoc`. This is partially isolated, but it creates a risky future XSS chain if sandbox flags or parent messaging change.
- Evidence: `src/renderer/index.html:7` includes `script-src 'self' 'unsafe-inline'`; `src/renderer/src/App.tsx:21546-21550` uses sandboxed workflow HTML `srcDoc`; `src/renderer/src/App.tsx:32032-32037` uses raw file HTML `srcDoc` with `allow-scripts`.
- Reproduction: Preview a hostile HTML file and verify script execution in the iframe; separately test whether any postMessage or navigation chain can reach parent/preload APIs.
- Recommended fix: Remove `unsafe-inline` where practical using hashes/nonces or external bundles. Remove `allow-scripts` from file HTML preview unless needed; otherwise isolate previews in a separate partition/window with no preload and strict CSP.
- Verification: CSP/static preview regression coverage and the local repro gate prove the reviewed unsafe CSP and `allow-scripts`/`srcDoc` patterns are no longer present.
- Residual risk: HTML preview is inherently high-risk in a privileged desktop app; keep it strictly isolated.

### F-011 Medium: Production Dependency Audit Has Open Advisories

- Status: Not reproduced after Phase 6C.
- Owner: Ambient Desktop.
- Affected files: `package.json`, `pnpm-lock.yaml`.
- Framework mapping: NIST SSDF, SLSA/OpenSSF, OWASP supply chain.
- Asset at risk: runtime dependency integrity.
- Exploit path: `pnpm audit --prod` reports high/moderate advisories in transitive production dependencies. Reachability is not yet confirmed, but launch should not proceed with known high/moderate advisories without upgrade, override, or documented risk acceptance.
- Evidence: `fast-xml-builder <=1.1.6` high via AWS Bedrock runtime under `@mariozechner/pi-ai`; `@anthropic-ai/sdk >=0.79.0 <0.91.1` moderate via `@mariozechner/pi-ai`; `fast-xml-builder =1.1.5` moderate; `elliptic <=6.6.1` low via `@rivet-dev/agent-os-core`.
- Reproduction: Run `pnpm audit --prod`.
- Recommended fix: Update `@mariozechner/pi-ai` and dependent SDKs if patched versions are available; use pnpm overrides only when compatible and tested; document reachability for anything not immediately fixable.
- Verification: `pnpm run test:dependency-audit-gate` and the local repro gate pass with only documented accepted-risk advisories.
- Residual risk: Native and model/plugin dependencies need continuous audit after launch; the current `elliptic` accepted-risk record has an owner and review deadline.

### F-012 Medium: Release/Update Hardening Needs Explicit Production Gate

- Status: Not reproduced after Phase 6D.
- Owner: Ambient Desktop.
- Affected files: `package.json`, `src/main/updateService.ts`, `scripts/publish-desktop-update.mjs`, `build/entitlements.mac.plist`, `build/entitlements.mac.inherit.plist`.
- Framework mapping: NIST SSDF, SLSA/OpenSSF, Electron update integrity.
- Asset at risk: installed desktop binary and release channel.
- Exploit path: The app uses a generic update feed and environment-overridable feed URLs. macOS entitlements allow JIT, unsigned executable memory, and disabled library validation. These may be justified for Electron/native modules, but they should be explicitly signed off before production because they weaken platform hardening.
- Evidence: `src/main/updateService.ts:57-60` accepts environment update URL overrides; `src/main/updateService.ts:125` calls `setFeedURL` with the configured URL; `package.json:220-224` configures a generic provider; `build/entitlements.mac.plist` and `build/entitlements.mac.inherit.plist` enable `allow-jit`, `allow-unsigned-executable-memory`, and `disable-library-validation`; `scripts/publish-desktop-update.mjs:13-23` contains release host/key defaults and remote root behavior.
- Reproduction: Inspect packaged update config and entitlements; perform a local update metadata tamper test before release.
- Recommended fix: Document signing/notarization and update integrity policy; remove environment feed overrides from production builds unless behind a signed/dev-only gate; justify or minimize entitlements; inspect packaged contents for secrets; run update tamper/downgrade tests.
- Verification: `pnpm run test:desktop-release-gate` and the local repro gate pass with production feed restrictions, explicit publish target hygiene, release manifest/hash checks, and entitlement policy documentation.
- Residual risk: Update infrastructure remains a high-value target and needs operational controls outside this repo.

### F-013 Critical: Terminal IPC Allows Renderer-Compromise To Spawn And Drive A Shell

- Status: Not reproduced after Phase 4B.
- Owner: Ambient Desktop.
- Affected files: `src/main/index.ts`, `src/main/terminalService.ts`, `src/preload/index.ts`.
- Framework mapping: Electron preload/IPC authority; STRIDE elevation of privilege; OWASP insecure output handling/excessive agency.
- Asset at risk: host shell, workspace files, process environment secrets.
- Exploit path: A compromised renderer can call `window.ambientDesktop.startTerminal({ permissionMode: "full-access" })` or workspace mode, receive a terminal id, and then call `window.ambientDesktop.writeTerminal(id, "<command>\n")`. The main process does not require a main-process user confirmation, does not bind `terminal:write` to a reviewed command, and does not require `terminal:review-command` before writes.
- Evidence: `src/preload/index.ts:416-418` exposes `startTerminal` and `writeTerminal`; `src/main/index.ts:1007-1009` accepts renderer-supplied `permissionMode`; `src/main/index.ts:8041-8043` starts the terminal directly; `src/main/index.ts:8104-8107` writes arbitrary renderer data to the pty; `src/main/terminalService.ts:16-42` spawns the default shell with a process environment derived from `process.env`.
- Reproduction: From a renderer devtools/XSS context, invoke the exposed preload methods to start a terminal and write a shell command. This bypasses the agent `bash` permission review path.
- Recommended fix: Treat terminal start/write as high-risk main-process operations. Require explicit main-process user intent to create an interactive terminal, bind writes to an active visible terminal session, and prevent hidden/background renderer scripts from creating or driving terminals. Do not accept renderer-supplied `permissionMode`; derive it from the active thread. Consider removing terminal creation from the broad preload API and using a capability token issued only after a trusted UI action.
- Verification: Regression coverage and the local repro gate prove terminal start/write is token-bound, command submission is reviewed in main, and the raw renderer-exposed terminal write path is gone.
- Residual risk: An intentionally open terminal remains powerful; the security goal is to prevent silent renderer-initiated shell execution.

### F-014 High: Generic Thread Settings IPC Can Escalate Permission Mode

- Status: Not reproduced after Phase 4A.
- Owner: Ambient Desktop.
- Affected files: `src/main/index.ts`, `src/shared/types.ts`, `src/preload/index.ts`.
- Framework mapping: OWASP LLM excessive agency; STRIDE elevation of privilege and tampering.
- Asset at risk: permission model, privileged tool gates, plugin/package install flows.
- Exploit path: The renderer-exposed `thread:update-settings` handler accepts `permissionMode` and writes it directly to the store. A compromised renderer can flip an active thread to `full-access`, causing later tool/package paths that trust thread permission mode to skip prompts.
- Evidence: `src/shared/types.ts:5337-5343` includes `permissionMode` in `UpdateThreadSettingsInput`; `src/preload/index.ts:237` exposes `updateThreadSettings`; `src/main/index.ts:6436-6439` parses and persists the update; `src/main/projectStore.ts:6590` and nearby update logic persist thread settings; `src/main/index.ts:7141-7148` auto-allows Pi privileged installs in full-access mode.
- Reproduction: From a renderer compromise, call `window.ambientDesktop.updateThreadSettings({ threadId, permissionMode: "full-access" })`, then invoke a high-risk action that checks the thread permission mode.
- Recommended fix: Split permission-mode changes into a dedicated main-process flow with explicit user confirmation and audit. Do not allow arbitrary renderer IPC to raise privilege. Only allow lowering privilege without prompt; require fresh confirmation for escalation.
- Verification: Regression coverage and the local repro gate prove generic thread settings cannot carry `permissionMode`; escalation uses a dedicated audited IPC path.
- Residual risk: If renderer compromise can still call other privileged handlers directly, this fix must be paired with broader IPC hardening.

### F-015 High: Renderer-Supplied Project Paths Can Rebase Workspace Authority

- Status: Not reproduced after Phase 4D.
- Owner: Ambient Desktop.
- Affected files: `src/main/index.ts`, `src/shared/types.ts`, `src/main/projectRegistry.ts`.
- Framework mapping: Electron IPC authority; filesystem confinement; STRIDE elevation of privilege/information disclosure.
- Asset at risk: files under arbitrary user-accessible directories outside the intended project.
- Exploit path: Project selection and project-board creation accept renderer-supplied `workspacePath` values and call `switchWorkspace()` directly. A compromised renderer can switch the active workspace to a broad readable/writable directory such as the user's home directory, after which `workspace:read-file`, previews, search, terminal, and project state are scoped to that new root. This turns workspace confinement into "whatever path the renderer supplied."
- Evidence: `src/shared/types.ts:5398-5404` defines project actions with raw `workspacePath`; `src/main/index.ts:5418-5424` calls `switchWorkspace(input.workspacePath, ...)`; `src/main/index.ts:5433-5437` switches during project-board creation; `src/main/index.ts:8168-8186` opens the workspace and registers it without proving it came from a trusted native picker or existing registry; `src/main/projectRegistry.ts:51-56` registers arbitrary normalized paths.
- Reproduction: From a renderer compromise, call `selectProject` or `createProjectBoard` with a user-accessible parent path, then use workspace file APIs to read files under that path.
- Recommended fix: Only switch to paths previously selected through a trusted main-process native picker or already present in the app-managed project registry. For renderer-supplied project references, pass opaque project ids rather than raw paths. Require explicit confirmation before rebasing the active workspace to a new path, and block broad roots such as `/`, the home directory, and system directories unless deliberately approved.
- Verification: Registry-backed project-id regression coverage and the local repro gate prove project and thread actions no longer accept renderer-supplied workspace paths.
- Residual risk: Users can legitimately open broad folders; the app should make that explicit and treat it as high authority.

## Security Classification Research

This section records the external-security-context review requested before remediation. It distinguishes "this is always a vulnerability" from "this is a valid product choice only if the trust boundary is explicit and consistently enforced."

### Research Sources

- OWASP LLM Top 10 2025: [Sensitive Information Disclosure](https://genai.owasp.org/llmrisk/llm022025-sensitive-information-disclosure/), [Excessive Agency](https://genai.owasp.org/llmrisk/llm062025-excessive-agency/), [Improper Output Handling](https://genai.owasp.org/llmrisk/llm052025-improper-output-handling/), and [Unbounded Consumption](https://genai.owasp.org/llmrisk/llm102025-unbounded-consumption/).
- OWASP Top 10 2021: [Broken Access Control](https://owasp.org/Top10/2021/A01_2021-Broken_Access_Control/index.html), [Security Misconfiguration](https://owasp.org/Top10/2021/A05_2021-Security_Misconfiguration/index.html), [Vulnerable and Outdated Components](https://owasp.org/Top10/2021/A06_2021-Vulnerable_and_Outdated_Components/), and [Software and Data Integrity Failures](https://owasp.org/Top10/2021/A08_2021-Software_and_Data_Integrity_Failures/).
- OWASP Cheat Sheets: [Authorization](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html), [Secrets Management](https://cheatsheetseries.owasp.org/cheatsheets/Secrets_Management_Cheat_Sheet.html), [Logging](https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html), and [OS Command Injection Defense](https://cheatsheetseries.owasp.org/cheatsheets/OS_Command_Injection_Defense_Cheat_Sheet.html).
- [Electron Security Tutorial and checklist](https://www.electronjs.org/docs/latest/tutorial/security).
- MITRE CWE entries: [CWE-312](https://cwe.mitre.org/data/definitions/312.html), [CWE-526](https://cwe.mitre.org/data/definitions/526.html), [CWE-59](https://cwe.mitre.org/data/definitions/59.html), [CWE-400](https://cwe.mitre.org/data/definitions/400.html), and related access-control/path-traversal mappings.
- [Node.js `node:vm` documentation](https://nodejs.org/api/vm.html).
- [MDN iframe sandbox documentation](https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/iframe).

### F-001: Workspace-Stored Provider Secrets Are Agent-Readable

- General classification: Usually a security hole if the product presents these as managed secrets rather than workspace files the agent is intentionally allowed to inspect.
- Why: OWASP treats credentials/API keys as sensitive information and recommends least-privilege access to secrets. CWE-312 covers cleartext sensitive data in a resource accessible to another control sphere. In agent systems, OWASP LLM02 treats credential disclosure through model/application context as sensitive information disclosure, and LLM06 treats unnecessary tool/data access as excessive permissions.
- Important nuance: Some AI coding tools intentionally expose project-local secrets to the agent when the user runs in a trusted, full-access mode. That can be acceptable only if the UI/documentation says workspace-local ignored files are in the agent's readable authority and the user explicitly opted into that model. It is not acceptable if Ambient-managed secret flows imply that provider keys are hidden from Pi or only released to approved commands.
- Usual fix: Store secret values in OS/app-managed storage or a secrets manager, keep only non-secret references in the workspace, apply least-privilege release at command execution time, and add deny rules/redaction for legacy secret paths.
- Ambient judgment: Security hole under Ambient's stated contract. The AGENTS instructions say cloud/API provider onboarding must use Ambient-managed secret flows and never expose values to Pi-visible output. Workspace-stored plaintext `*.secret` files violate that boundary.

### F-002: Ambient API Key And Process Environment Leak To Agent/Tool Processes

- General classification: Strongly considered a security hole when generic child processes, tools, or model-visible shell output inherit secrets they do not need.
- Why: CWE-526 specifically describes sensitive data in environment variables being accessible to child processes and later inserted into logs or outputs. OWASP Logging guidance says access tokens, authentication passwords, encryption keys, and primary secrets should be removed, masked, sanitized, hashed, or encrypted before logging. OWASP Secrets Management recommends least-privilege access and limiting exposure of actual secret values.
- Important nuance: Environment variables are still a common deployment mechanism. The flaw is not "an env var exists"; it is broad inheritance into untrusted or semi-trusted execution contexts plus Pi-visible stdout/stderr/artifacts without redaction.
- Usual fix: Build minimal env maps per child process, pass credentials only to the exact code path that needs them, use short-lived scoped credentials when possible, and centrally redact known secret values and secret-like env names from logs/tool output/artifacts.
- Ambient judgment: Launch-blocking security hole. Agent shell and package processes do not need the Ambient provider API key by default.

### F-003: Workspace-Writable Authority State Enables Permission, Trust, And Audit Tampering

- General classification: Security hole if the data controls permissions, grants, trust, or audit, and the actor being governed can write it.
- Why: OWASP Broken Access Control includes modifying internal application state or metadata to bypass access control, violating least privilege/deny-by-default, and elevation of privilege. OWASP Authorization guidance says permissions must be validated on every request in trusted code, and audit/logging must not be trivially mutable by the actor being monitored. OWASP Secrets Management also calls out audit resilience against tampering.
- Important nuance: Workspace-local state is acceptable for non-authoritative caches and user-visible artifacts. It is not acceptable for security decisions unless protected against the same actor whose actions it controls.
- Usual fix: Move authority-bearing state to app-managed storage outside the agent-writable workspace, enforce access-control decisions in the main process, and make audit/security state tamper-resistant or at least tamper-evident.
- Ambient judgment: Launch-blocking security hole. It lets the agent modify the policy state that is supposed to constrain the agent.

### F-004: Browser Credential Metadata Can Be Tampered From The Workspace

- General classification: Security hole when mutable metadata can redirect an encrypted secret to a different relying party or origin.
- Why: This is a tampering/spoofing variant of insufficient credential protection. OWASP Authorization and Broken Access Control warn against metadata manipulation and user-controlled object references in security decisions. CWE-312 and OWASP Secrets Management focus on protecting secret storage, but the security property here also requires authenticated binding between the secret and its origin/account metadata.
- Important nuance: Encrypting only the password is not enough if the untrusted side can alter the metadata used to decide where the password may be used. User approval helps, but it is weakened if the prompt is based on already-tampered metadata.
- Usual fix: Store browser credential records outside workspace authority, include origin/account metadata in authenticated encryption or a signed record, and force re-entry or explicit migration when security-critical metadata changes.
- Ambient judgment: Security hole, and mostly a consequence of F-003. It remains worth fixing explicitly so credential records fail closed on tampering.

### F-005: Workspace File Preview And Media Serving Follow Symlinks Outside The Workspace

- General classification: Classic security hole in any sandbox/path-confinement feature.
- Why: MITRE CWE-59 covers link-following before file access and lists unintended read/modify/bypass impacts. OWASP Broken Access Control maps path traversal and link following into its access-control category. A lexical "inside workspace" check is not a complete filesystem boundary when symlinks, hardlinks, mount points, or platform aliases are involved.
- Important nuance: Following symlinks can be a legitimate developer convenience if it is explicit and the target is shown/approved. It is not safe as a silent default for a security boundary.
- Usual fix: Use `lstat` before following, canonicalize with `realpath`, reject or prompt on symlinks whose real target escapes the workspace, mark symlinks in file lists, and test every read/write/media/search/reveal path.
- Ambient judgment: Originally launch-blocking. Phase 3A/3B closes the reviewed preview/media/write/search/list/open escape paths; remaining hardlink/platform/dirfd work is defense-in-depth rather than the original F-005 exploit.

### F-006: Main Renderer Is Unsandboxed Despite A Broad Privileged IPC Bridge

- General classification: Commonly considered Electron hardening debt; becomes a high-severity security hole when combined with broad privileged IPC and any renderer-XSS/local-content path.
- Why: Electron's security checklist recommends context isolation, process sandboxing, restrictive CSP, sender validation for IPC, and not exposing Electron APIs to untrusted web content. Electron explicitly notes that Electron code has filesystem/shell power and that XSS impact is higher in Electron than on the web.
- Important nuance: `sandbox: false` alone is not necessarily a vulnerability for a fully trusted local renderer with a minimal preload. The issue is the combination of unsandboxed renderer process, very broad preload bridge, and high-impact handlers.
- Usual fix: Enable renderer sandbox where possible, reduce preload surface, validate sender/frame/window for every high-authority IPC call, and ensure privileged operations require main-process policy checks rather than renderer state.
- Ambient judgment: High-severity security architecture issue. It is not the only exploit by itself, but it materially amplifies F-008, F-010, F-013, F-014, and F-015.

### F-007: Default Permission Mode Is Full Access

- General classification: Security design flaw for an agentic system unless full access is explicitly chosen and continuously visible.
- Why: OWASP LLM06 defines excessive agency as excessive functionality, permissions, or autonomy, and recommends minimizing extensions/functions/permissions plus user approval for high-impact actions. OWASP Authorization and Broken Access Control recommend least privilege and deny by default.
- Important nuance: Full-access mode can be a valid power-user feature. The flaw is defaulting new users/threads to maximum authority, especially when the agent can execute shell and mutate files.
- Usual fix: Default to the least authority that supports ordinary workflows, require explicit opt-in for full access, make the state obvious in the UI, and still require fresh confirmation for especially high-impact actions.
- Ambient judgment: Launch-blocking product-security issue unless the launch positioning intentionally says Ambient is a full-trust local automation tool by default.

### F-008: External URL And Window Open Handling Allows `file:` And Unvalidated Targets

- General classification: Electron security hole when the URL can be influenced by renderer or untrusted content.
- Why: Electron's checklist says to disable/limit navigation, disable/limit new windows, avoid `file://` where possible, and not use `shell.openExternal` with untrusted content because it can compromise the user's host or execute commands through protocol handlers.
- Important nuance: Opening trusted `https:` links from trusted UI is normal. Opening arbitrary schemes or `file:` URLs from renderer-controlled inputs is the risky part.
- Usual fix: Parse URLs with the platform URL parser, allowlist schemes/origins, deny `file:`, `javascript:`, and custom schemes by default, and use separate explicit local-file APIs for reveal/open operations.
- Ambient judgment: Security hole if any untrusted content, preview, browser page, or renderer compromise can reach these handlers.

### F-009: Workflow VM Runtime Limits Do Not Stop Synchronous CPU Loops

- General classification: Availability vulnerability and sandbox-design flaw for untrusted/generated code.
- Why: Node's official `node:vm` documentation states that the module is not a security mechanism and should not be used to run untrusted code. CWE-400 covers uncontrolled resource consumption causing CPU/memory denial of service. OWASP LLM10 covers unbounded consumption, including resource-intensive operations and the need for timeouts/throttling.
- Important nuance: `vm.Script` is useful for controlled plugin/runtime shaping, but its timeout on initial evaluation does not make later exported functions safe. Regex loop blocking is lint, not a security boundary.
- Usual fix: Run generated workflow code in a worker thread or child process with a hard kill boundary, timeouts, memory/CPU limits where available, and least-authority capabilities.
- Ambient judgment: Medium-to-high security issue. It may not expose secrets, but it can hang the main process and disable security/user controls.

### F-010: Renderer CSP And HTML Preview Remain Loose

- General classification: Security hardening issue that becomes a vulnerability if hostile HTML or renderer XSS can reach privileged APIs.
- Why: Electron recommends restrictive CSP such as `script-src 'self'` and warns that XSS impact is higher in Electron. OWASP LLM05 recommends treating generated/model-controlled content as untrusted, using validation/encoding, and strict CSP. MDN documents that iframe sandbox flags deliberately control script execution, same-origin behavior, popups, and navigation, and warns that certain sandbox combinations can erase meaningful isolation.
- Important nuance: A sandboxed `srcDoc` preview can be safe if it has no preload, no same-origin privileges, no parent access, no dangerous navigation, and no permissive messaging bridge. Allowing scripts is not automatically a bug, but it raises the required isolation bar.
- Usual fix: Remove `unsafe-inline` where practical, remove `allow-scripts` from file previews unless necessary, serve hostile previews from a separate origin/partition/window with no preload, and test postMessage/navigation/parent-access chains.
- Ambient judgment: Medium issue on current evidence, but it becomes launch-blocking if paired with any path to call `window.ambientDesktop` or privileged IPC.

### F-011: Production Dependency Audit Has Open Advisories

- General classification: Recognized supply-chain risk; severity depends on reachability and exploitability.
- Why: OWASP A06 says applications are likely vulnerable if components are vulnerable, unsupported, out of date, or not regularly scanned and patched. Electron also recommends keeping Electron/Chromium/Node and dependencies current. OWASP A08 covers dependency/update integrity and use of trusted sources/signatures.
- Important nuance: Not every advisory in a transitive dependency is exploitable in this app. Launch risk should be decided by advisory severity, reachability, available patch, and whether a compensating control exists.
- Usual fix: Upgrade direct dependencies, use overrides only after compatibility testing, remove unused packages, document accepted exceptions with owner/deadline, and keep automated local audit/SCA in the release gate.
- Ambient judgment: Medium launch gate. High/moderate advisories should be patched or explicitly risk-accepted before production.

### F-012: Release/Update Hardening Needs Explicit Production Gate

- General classification: Release integrity issue; insecure auto-update is widely considered high impact because it becomes arbitrary code distribution.
- Why: OWASP A08 explicitly includes auto-update without sufficient integrity verification and recommends digital signatures or similar mechanisms to verify source and integrity. OWASP A06 also calls for patch management and trusted/signed packages. Electron emphasizes keeping the framework current and treating dependencies/release configuration as part of app security.
- Important nuance: Generic update feeds and powerful entitlements can be legitimate in Electron apps. The risk is not having a release gate that proves feed authenticity, signing/notarization, downgrade resistance, and entitlement necessity.
- Usual fix: Require signed/notarized production artifacts, verify update metadata and packages, remove dev/environment feed overrides from production, test tamper/downgrade cases, and document entitlement justifications.
- Ambient judgment: Medium-to-high release blocker depending on current packaging pipeline. It must be explicit before production.

### F-013: Terminal IPC Allows Renderer-Compromise To Spawn And Drive A Shell

- General classification: High-confidence security hole when renderer-controlled IPC can spawn and write to a shell without a trusted user-intent gate.
- Why: Electron says privileged IPC must validate senders and should not expose unnecessary APIs to untrusted content. OWASP OS Command Injection guidance recommends avoiding direct OS command execution, parameterizing/validating when unavoidable, and running with least privilege. OWASP LLM06 warns against open-ended extensions such as "run a shell command" and recommends human approval and complete mediation for high-impact actions.
- Important nuance: A visible user-opened terminal is a legitimate feature. The flaw is a scriptable renderer path that can create or drive it silently and choose authority parameters.
- Usual fix: Gate terminal creation in trusted main-process UI/user gesture state, derive authority from server/main state, issue short-lived capability tokens for visible terminal sessions, restrict writes to that session, and minimize environment inheritance.
- Ambient judgment: Launch-blocking security hole. This is the clearest renderer-to-host escalation chain.

### F-014: Generic Thread Settings IPC Can Escalate Permission Mode

- General classification: Access-control/security-state tampering vulnerability.
- Why: OWASP Broken Access Control lists modification of internal application state/metadata to bypass access checks and elevation of privilege. OWASP Authorization says permissions must be validated on every request and not rely on client-side checks. OWASP LLM06 recommends complete mediation by downstream systems rather than letting the model/client decide what is allowed.
- Important nuance: The renderer can legitimately edit ordinary thread settings. Permission mode is not ordinary UI preference state; it changes the authority of future actions.
- Usual fix: Split permission escalation into a dedicated, audited main-process flow with explicit user confirmation; allow lowering privilege freely; reject generic setting writes that raise authority.
- Ambient judgment: Launch-blocking when combined with broad renderer authority. A compromised renderer must not be able to turn itself or a thread into full access.

### F-015: Renderer-Supplied Project Paths Can Rebase Workspace Authority

- General classification: Access-control/path-authority vulnerability when renderer-provided paths define the security boundary.
- Why: OWASP Broken Access Control warns against parameter tampering, internal state manipulation, force browsing, and user-controlled object identifiers. The Authorization Cheat Sheet recommends avoiding user-tamperable direct object references and performing access checks on every request. Electron also recommends sender validation for IPC.
- Important nuance: Users can intentionally open any folder they own, including broad folders. The security issue is allowing renderer-controlled strings to silently redefine the active workspace without proof that they came from a trusted picker, trusted registry entry, or explicit user approval.
- Usual fix: Use opaque project IDs for renderer references, only resolve paths in main process from an app-managed registry or native picker result, require explicit confirmation for new/broad roots, and block dangerous roots by default.
- Ambient judgment: High security hole. It undermines all workspace-scoped permission decisions.

### Cross-Finding Launch Judgment

- Current local release gate: all F-001 through F-015 repros return `not-reproduced`.
- Launch blockers: no original Critical/High blocker remains reproduced by the local repro gate.
- Defense-in-depth note: Phase 6E now adds an OS-level child-process hard-kill release gate for generated workflow CPU-loop regressions. A full product RPC worker bridge remains a possible future hardening step beyond the current VM timeout and async continuation guards.
- Continuing obligations: keep dependency accepted-risk records current, rerun the local repro gate before release, and keep live Ambient/Pi dogfood in the release signoff path because product behavior depends on real Pi/Ambient sessions.
- Agent-secret nuance: The industry does not universally treat agent access to all local/project secrets as a strict flaw. It is acceptable only under a full-trust product model where the user is clearly told the agent can inspect those secrets. Ambient's current secret-flow language points the other way, so F-001/F-002 should be treated as real vulnerabilities unless the product deliberately changes that contract.

## Review Tracker

| Phase | Status | Evidence |
| --- | --- | --- |
| Phase 0: Baseline automated checks | Initial pass complete | See Execution Log. Typecheck passed; focused tests passed; full `pnpm test` blocked by local native/runtime mismatch; audit has open advisories. |
| Phase 1: Asset inventory and trust boundaries | Initial pass complete | Findings F-001 through F-004 identify critical secret/state boundaries. |
| Phase 2: Preload and IPC authority review | Initial pass complete | 260 preload invokes and 260 main handlers inventoried; see F-006, F-013, F-014, F-015. |
| Phase 3: Electron hardening | Initial pass complete | Main renderer sandbox, terminal IPC, project switching, external URL, entitlements, and update hardening gaps recorded in F-006, F-008, F-012, F-013, F-015. |
| Phase 4: Rendered content, CSP, and XSS chains | Initial pass complete | CSP and HTML preview concerns recorded in F-010; full exploit-chain test remains pending. |
| Phase 5: Secrets, credentials, privacy, and retention | Initial pass complete | Critical secret disclosure paths recorded in F-001 and F-002; browser credential tampering in F-004. |
| Phase 6: Agentic Pi, workflow, tool, plugin, MCP, and package execution | Initial pass complete | Tool/process env, workspace state, default full access, permission escalation, terminal IPC, and workflow DoS gaps recorded in F-001, F-002, F-003, F-007, F-009, F-013, F-014. |
| Phase 7: Filesystem, git, shell, native, Docker, and sandbox boundaries | Initial pass complete | Symlink escape, arbitrary project-root rebasing, and workspace authority-state write issues recorded in F-003, F-005, F-015. |
| Phase 8: Browser automation, OAuth, and localhost surfaces | Initial pass complete | Stored browser credential tampering and URL handling recorded in F-004 and F-008. |
| Phase 9: Network, Ambient/Pi streaming, updates, and release integrity | Initial pass complete | Dependency and update/release hardening recorded in F-011 and F-012. |
| Phase 10: Targeted exploit-chain validation | Local gate complete | `pnpm run test:security-repro-gate` runs all F-001 through F-015 repros through the loopback-only local server and fails release if any required finding is vulnerable, inconclusive, missing, or errored. |
