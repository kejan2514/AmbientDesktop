# UI Model Harness

This harness captures a structured model of the running Electron UI through Chrome DevTools Protocol. It is intended to catch layout defects before screenshot review becomes necessary.

Run:

```sh
pnpm run test:ui-model
```

Strict mode exits nonzero when gated violations are present. Report-only findings still appear in the JSON and Markdown output:

```sh
pnpm run test:ui-model:strict
```

Rule self-test mode injects known bad runtime-only DOM defects and verifies that the collector reports them:

```sh
pnpm run test:ui-model:self-test
```

Stress mode creates heavier deterministic UI states:

```sh
pnpm run test:ui-model:stress
```

Interaction mode opens representative non-default UI states:

```sh
pnpm run test:ui-model:interactions
```

Run all deterministic profiles together with:

```sh
pnpm run test:ui-model:all
```

The combined run includes core, stress, and interaction profiles. It isolates each scenario in a fresh Electron session and fixture workspace, then aggregates the scenario JSON files into one Markdown/HTML report. This is slower than the single-profile commands, but it avoids cross-scenario state contamination.

After the 2026-05-17 polish pass, the deterministic baseline is zero findings. Use the zero-baseline ratchet when a release candidate should fail on any UI-model finding, including findings that would otherwise be report-only:

```sh
pnpm run test:ui-model:all:zero
```

Outputs are written to `test-results/ui-model/`:

- `report.md`: human-readable summary
- `report.html`: interactive report with repro links
- `summary.json`: scenario counts, violation totals, grouped findings, and annotation inventory
- `<scenario>.json`: DOM geometry, accessibility nodes, computed style summaries, tooltip samples, and violations
- `electron-output.log`: Electron launch output for debugging

The default command is report-only so rules can be tuned before becoming a release gate.

Serve the HTML report with a local repro backend:

```sh
pnpm run test:ui-model:serve
```

Open the printed `http://127.0.0.1:9597/report.html` URL. Each violation has a "Launch repro" link that rebuilds that scenario in an isolated repro workspace, starts the Electron app, highlights the target element, and keeps the app open for inspection. The repro backend writes its temporary outputs under `test-results/ui-model-repro/` and uses `test-results/ui-model-repro-fixture/` for app state.

The report server binds only to `127.0.0.1`, serves files only from the configured report directory, checks loopback `Host` and `Origin` headers, injects a per-server nonce into repro links, and only launches saved scenario/violation pairs from the generated report.

Reports include a Finding Groups table whenever violations are present. Groups combine repeated findings by surface, component, rule type, gate, and impact so shared component regressions are visible before drilling into individual selectors. Reports also include an Annotation Inventory table for explicit UI-model contracts such as intentional truncation, compressed controls, alignment groups, scroll containers, and overflow intent. The inventory is diagnostic context; it does not create blanket allowlists.

See `docs/headless-ui-qa-handoff.md` for the handoff brief and `adoptMaxUIFixSuggestions.md` for the staged plan to expand this into the broader headless UI QA suite.

The default UI-model workspace is `test-results/ui-model-fixture/workspace`, not the repo root. Set `AMBIENT_UI_MODEL_WORKSPACE=/path/to/workspace` only when a scenario intentionally needs a real workspace state.

## Gating Model

Each scenario has metadata for surface, viewport, profile, and exposure. Each violation is classified with:

- `exposure`: `common`, `plausible-heavy`, `rare-boundary`, or `pathological`
- `impact`: `blocker`, `major`, `accessibility`, `minor`, or `info`
- `gate`: `fail` or `report`

Strict mode fails only on gated findings. The default policy fails common and plausible-heavy blocker, major, and accessibility findings; minor findings are report-only.

## Local Release Use

The desktop local release checklist includes:

```sh
pnpm run test:ui-model:strict
pnpm run test:ui-model:self-test
pnpm run test:ui-model:all:zero
```

`test:ui-model:strict` is the fast blocking UI gate for core strict policy. `test:ui-model:self-test` proves the detector rules still fire. `test:ui-model:all:zero` runs core, stress, and interaction profiles and fails on any deterministic finding. The current baseline is 23 scenarios, 0 total findings, 0 report-only findings, and 0 gate failures.

`test:ui-model:all` remains useful as a report-only diagnostic command when a developer is deliberately collecting a new baseline before deciding whether to fix, annotate, or promote findings.

## Live-Seeded Diagnostic Review

After the deterministic baseline is stable, run the optional live-seeded diagnostic lane against a disposable copy of a real Ambient/Codex snapshot:

```sh
AMBIENT_LIVE_SEEDED_USER_DATA=/path/to/snapshot/userData \
AMBIENT_LIVE_SEEDED_WORKSPACE=/path/to/snapshot/workspace \
pnpm run test:ui-model:live-seeded
```

During the temporary Ambient provider outage, this wrapper defaults to GMI Cloud and passes the provider environment through to the UI-model app launch. It accepts `GMI_CLOUD_API_KEY`, `GMI_API_KEY`, `GMI_CLOUD_API_KEY_FILE`, or the ignored `ignored-provider-key-file.txt` file, but its JSON summaries only record credential source labels such as `env:GMI_CLOUD_API_KEY_FILE`; they do not write secret values.

The wrapper copies the source `userData` and workspace into `test-results/ui-model-live-seeded/runs/<timestamp>/`, runs a report-only UI-model collection against that copy, and writes `live-seeded-review.json` plus `test-results/ui-model-live-seeded/latest.json`. By default it samples Project Board and Local Tasks scenarios most likely to expose real generated-content layout issues. Pass `--all-profiles` to run the full deterministic catalog or `--scenario=name` to target a specific state. Any findings are diagnostic triage debt, not a strict release gate; convert recurring live-only problems into sanitized deterministic scenarios before relying on the zero-baseline ratchet.

## Current Scenarios

- `main-shell-desktop` at 1440x900
- `main-shell-medium` at 1280x800
- `main-shell-compact` at 960x720
- `project-board-desktop` at 1440x900
- `project-board-medium` at 1280x800
- `project-board-compact` at 960x720

Stress profile:

- `project-board-long-names-desktop` at 1440x900
- `project-board-long-names-compact` at 960x720
- `project-board-many-cards-25-desktop` at 1440x900
- `project-board-many-cards-25-compact` at 960x720
- `local-tasks-many-items-desktop` at 1440x900
- `local-tasks-long-names-compact` at 960x720

Interaction profile:

- `settings-search-active` at 1280x800: Settings panel with a provider/permission/API-key search active.
- `project-board-draft-detail-open` at 1280x800: Draft Inbox with a candidate detail inspector open beside the board.
- `project-board-pm-review-open` at 1280x800: Project Board Charter source/PM-review workspace with the sticky source inspector visible.
- `local-tasks-edit-card-open` at 1280x800: Local Tasks Kanban with a task edit form open.
- `api-key-dialog-open` at 960x720: Provider API-key dialog open from the topbar pill with the secret input focused.
- `model-selector-open` at 960x720: Composer model selector menu open at compact width.
- `workflow-run-console-open` at 1280x800: Workflow Agent run console with retained events, model calls, permissions, diagram controls, and audit evidence visible.
- `workflow-artifact-preview-open` at 1280x800: Workflow Agent outputs with the retained Markdown report artifact previewed in the Files panel.
- `permission-dialog-open` at 960x720: Reusable permission prompt open with plugin trust, detail text, and persistent grant actions visible.
- `browser-picker-active` at 1280x800: Browser panel with an active element picker waiting for a user selection.
- `plugin-import-candidate-visible` at 1280x800: Plugins Marketplace tab with Ambient curated import candidates and provenance metadata visible.

Run a subset with:

```sh
pnpm run test:ui-model -- --scenario=project-board-desktop
```

Run a profile with:

```sh
pnpm run test:ui-model -- --profile=core
```

## Annotation Conventions

Use annotations sparingly when a layout rule needs design intent:

- `data-ui-allow-truncation="true"` for intentional text truncation
- `data-ui-overflow="clip-intentional"` for intentional clipping
- `data-ui-align-group="name"` to opt elements into alignment checks
- `data-ui-align-axis="top|left|right|bottom|width|height"` to choose the measured alignment axis
- `data-ui-allow-lonely-row="true"` for intentional single-control wrapped rows
- `data-ui-allow-fragmented-controls="true"` for intentional multi-row control clusters
- `data-ui-allow-compressed-control="true"` for intentionally abbreviated select/control labels
- `data-ui-allow-small-target="true"` for intentional small non-primary interactive targets
- `data-ui-allow-unlabeled-control="true"` only for intentionally unnamed internal controls that are not user-facing
- `data-ui-scroll-container="required"` for panes whose overflowing content must remain reachable through native scrolling
- `data-ui-allow-sticky-overlap="true"` only for intentional sticky/fixed overlays that may cover underlying content
