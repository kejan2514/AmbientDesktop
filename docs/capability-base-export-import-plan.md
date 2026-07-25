# Capability Base Export / Import Plan

## Purpose

Ambient needs a stable capability base so hardening runs do not start from a
fresh, partially configured product on every build. A capability base is a
redacted, validated snapshot of product capability readiness for one app
profile and workspace family. Scenario runs should fork overlays from that base,
exercise the product, and then discard or report overlay state.

This feature is high priority because provider installs, `gws` auth, local model
caches, generated capability packages, and Ambient-managed secrets live across
several storage roots. Without a base export/import contract, failures from
missing setup look like product regressions and parallel hardening is noisy.

## Goals

- Export a redacted manifest that describes installed and available
  capabilities, package pins, generated capability provenance, readiness checks,
  credential requirements, Google `gws` account hints, local model cache needs,
  and app/profile identity.
- Import the manifest in preview mode to compare the target machine/app profile
  against the expected base before running scenarios.
- Apply safe portable state: workspace-local Ambient CLI packages, generated
  capability source packages, env-binding names, package metadata, and scenario
  runner labels.
- Rehydrate non-portable state through explicit product flows:
  `ambient_cli_secret_request`, approved `ambient_cli_env_bind`, Settings /
  Plugins Google auth, and local model/runtime setup checks.
- Create disposable scenario overlays from a validated base so install/remove
  scenarios can mutate state without damaging the base.

## Non-Goals

- Do not export secret values, OAuth refresh tokens, browser cookies, keychain
  items, or raw Google `gws` config directories.
- Do not copy paid API credentials between machines automatically.
- Do not make Codex cache plugins part of the release-facing base while they are
  excluded from the Ambient control plane.
- Do not include large model weights or binary runtime caches in the default
  bundle. The base should reference them by provider, path kind, size/checksum
  when available, and readiness state.

## Manifest Shape

The first schema should be intentionally boring JSON:

```json
{
  "schemaVersion": "ambient-capability-base-v1",
  "baseId": "primary-mac-live-providers-2026-05",
  "createdAt": "2026-05-13T00:00:00.000Z",
  "app": {
    "name": "Ambient Desktop",
    "version": "0.1.x",
    "buildId": null,
    "sourceRevision": null
  },
  "machine": {
    "id": "primary-mac",
    "os": "darwin",
    "arch": "arm64"
  },
  "profile": {
    "workspaceRootKind": "absolute-local",
    "electronUserDataKind": "app-profile",
    "scenarioOverlayRoot": ".ambient/scenario-overlays"
  },
  "ambientCli": {
    "packages": [
      {
        "packageName": "pi-arxiv",
        "sourceKind": "bundled|workspace-imported|generated|external",
        "version": null,
        "descriptorSha256": "sha256:...",
        "commands": ["arxiv_search", "arxiv_paper"],
        "health": "ready|missing_dependency|secret_required|unknown",
        "envRequirements": ["BRAVE_API_KEY"],
        "envBindings": [
          {
            "envName": "BRAVE_API_KEY",
            "sourceKind": "ambient-secret|workspace-file|missing",
            "valueExported": false
          }
        ]
      }
    ]
  },
  "generatedCapabilities": {
    "sources": [
      {
        "sourcePath": ".ambient/capability-builder/packages/piper-tts",
        "installedSource": ".ambient/cli-packages/imported/piper-tts",
        "descriptorSha256": "sha256:...",
        "lastValidation": "passed|failed|missing"
      }
    ]
  },
  "providerCatalog": {
    "catalogVersion": null,
    "selectedProviderIds": ["search.brave", "voice.piper"],
    "planOnlyProviderIds": ["search.searxng", "agentic-services.stripe-sandbox"]
  },
  "googleWorkspace": {
    "authMode": "gws",
    "gwsBinary": "managed|custom|missing",
    "configRootKind": "app-profile|custom|missing",
    "accounts": [
      {
        "accountHint": "work",
        "services": ["gmail", "calendar", "drive"],
        "validationState": "ready|needs_login|missing_scope|unknown"
      }
    ]
  },
  "localAssets": {
    "models": [
      {
        "providerId": "vision.minicpm-v",
        "pathKind": "local-cache|workspace|missing",
        "sizeBytes": null,
        "checksum": null,
        "validationState": "ready|missing|not_checked"
      }
    ]
  },
  "secrets": {
    "valuesExported": false,
    "required": [
      {
        "envName": "BRAVE_API_KEY",
        "providerId": "search.brave",
        "configured": true,
        "rehydration": "ambient_cli_secret_request|ambient_cli_env_bind"
      }
    ]
  },
  "warnings": []
}
```

## Product Surface

- Main-process service: `capabilityBaseService`.
- IPC:
  - `capability-base:export`
  - `capability-base:import-preview`
  - `capability-base:apply`
  - `capability-base:validate`
  - `capability-base:create-overlay`
- Renderer:
  - Add a Settings / Plugins / Capability Bases panel.
  - Show installed base, last validation, missing credentials, missing `gws`
    login, missing local assets, and scenario overlay count.
  - Provide Export, Import Preview, Apply, Validate, and Create Overlay actions.
- Scenario runner:
  - Require `--base <base-id|manifest-path>` for live lanes once the feature is
    available.
  - Emit base id, overlay id, import-preview result, and validation result in
    every scenario report.

## Implementation Phases

### Local Secret Snapshot Helper

Until the product-native Capability Bases panel lands, use the local-only
hardening helper for machine-local prepared bases:

```bash
pnpm run hardening:snapshot -- create \
  --source-base /Users/example/.ambient-hardening/bases/example-core-no-secrets \
  --group shared-secrets \
  --name example-shared-secrets \
  --contains-secrets \
  --expect-ambient-api-key \
  --expect-google-workspace \
  --expect-secret-env BRAVE_API_KEY \
  --expect-secret-env CARTESIA_API_KEY \
  --expect-secret-env ELEVENLABS_API_KEY \
  --strict
```

This helper is intentionally **local only**. With `--contains-secrets`, it
copies Ambient-managed provider secret files, `ambient-api-key.enc`, Google
Workspace `gws` OAuth config, and the managed `gws` binary. It does not copy
browser cookies/cache/session storage, and it writes a `meta/manifest.json` that
records paths, sizes, modes, and redacted verification status without recording
secret values or secret hashes.

1. Redacted export only.
   - Inventory Ambient CLI registry, env-binding names, generated capability
     history, provider catalog cards, Google `gws` status, app/profile facts,
     and local model readiness summaries.
   - Reuse diagnostic bundle patterns where possible, but produce a stable
     machine-readable manifest rather than an ad hoc support artifact.
2. Import preview and validation.
   - Compare a manifest against the current workspace/app profile.
   - Report exact missing packages, missing env bindings, missing secrets,
     missing `gws` accounts/scopes, missing local assets, and app version drift.
   - No mutation in preview.
3. Safe apply.
   - Copy or register workspace-local packages and generated capability sources.
   - Recreate env-binding names without values.
   - Mark credentials and Google accounts as needing rehydration when they are
     not already present.
4. Scenario overlays.
   - Create temporary workspace/userData overlays from a validated base.
   - Track overlay mutations and cleanup.
   - Preserve full logs/artifacts while keeping Pi-visible previews bounded.
5. Credential and `gws` rehydration.
   - Route API keys through `ambient_cli_secret_request` or approved ignored
     files via `ambient_cli_env_bind`.
   - Route Google readiness through Settings / Plugins and `gws` status checks.
   - Never expose secret values or OAuth tokens in the manifest or reports.
6. Cross-machine dogfood.
   - Export from the primary Mac.
   - Import-preview on UTM, Mac laptop, and `drone`.
   - Apply only deterministic/package-safe parts unless credentials and local
     assets are intentionally provisioned.

## High-Risk Edges

- Secret leakage through env-binding file paths, command output, package
  descriptors, validation logs, or diagnostic bundles.
- Google account confusion when multiple `accountHint` values exist.
- App build drift where a base exported from one build imports into another with
  silently incompatible registry shapes.
- Generated capability source drift between `.ambient/capability-builder` and
  `.ambient/cli-packages/imported`.
- Scenario overlays accidentally mutating the stable base.

## Acceptance Bar

The feature is useful when a clean app profile can import-preview a base and
produce a precise readiness report in under a minute, and a prepared profile can
create an overlay and run the deterministic first slice without reinstalling
providers or losing credential/auth state between app builds.
