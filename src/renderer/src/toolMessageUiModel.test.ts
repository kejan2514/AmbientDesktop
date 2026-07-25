import { describe, expect, it } from "vitest";
import type { ChatMessage } from "../../shared/threadTypes";
import {
  artifactMediaKindFromPath,
  artifactPreviewRoute,
  collectArtifactPathHints,
  mediaPreviewUnavailableMessage,
  parseToolMessage,
  resolveInlineArtifactPath,
  toolLargeOutputPreviewViewModel,
  toolLongformInputPreviewDisplaySummary,
} from "./toolMessageUiModel";

describe("tool message UI model", () => {
  it("parses write tool messages into artifact previews", () => {
    const parsed = parseToolMessage(
      [
        "write completed",
        "",
        "Input",
        JSON.stringify({ path: "src/generated.ts", content: "" }, null, 2),
        "",
        "Result",
        "Successfully wrote 0 bytes to src/generated.ts",
      ].join("\n"),
      "write",
      "/workspace",
    );

    expect(parsed.artifactPath).toBe("src/generated.ts");
    expect(parsed.writePreview).toEqual({
      path: "src/generated.ts",
      content: "",
      language: "typescript",
    });
    expect(parsed.longformInputPreview).toMatchObject({
      summary: "src/generated.ts",
      items: [{ path: "src/generated.ts", preview: "", chars: 0, truncated: false }],
    });
  });

  it("parses file_write messages into the shared longform preview", () => {
    const parsed = parseToolMessage(
      [
        "file_write completed",
        "",
        "Input",
        JSON.stringify({ path: "reports/out.md", content: "hello" }, null, 2),
        "",
        "Result",
        "Wrote reports/out.md",
      ].join("\n"),
      "file_write",
      "/workspace",
    );

    expect(parsed.artifactPath).toBe("reports/out.md");
    expect(parsed.preview).toBe("reports/out.md");
    expect(parsed.longformInputPreview).toMatchObject({
      title: "Input",
      runningTitle: "Writing file",
      summary: "reports/out.md",
      items: [{ path: "reports/out.md", language: "markdown", preview: "hello", chars: 5 }],
    });
  });

  it("parses capability apply-repair input into multi-file previews", () => {
    const parsed = parseToolMessage(
      [
        "ambient_capability_builder_apply_repair preparing",
        "",
        "Input",
        JSON.stringify(
          {
            packageName: "ambient-elevenlabs-tts",
            reason: "Convert the TTS artifact generator into a provider.",
            files: [
              {
                path: "ambient-cli.json",
                content: '{"name":"ambient-elevenlabs-tts"}\n... (1718 chars total)',
                rationale: "Add provider metadata.",
              },
              {
                path: "scripts/run.mjs",
                content: "console.log('ok');\n",
              },
            ],
          },
          null,
          2,
        ),
      ].join("\n"),
      "ambient_capability_builder_apply_repair",
      "/workspace",
    );

    expect(parsed.preview).toBe("ambient-elevenlabs-tts · 2 files · 1,737 chars");
    expect(parsed.resultPreview).toBe("");
    expect(parsed.applyRepairPreview).toMatchObject({
      packageName: "ambient-elevenlabs-tts",
      reason: "Convert the TTS artifact generator into a provider.",
      totalChars: 1737,
      files: [
        {
          path: "ambient-cli.json",
          charCount: 1718,
          language: "json",
          rationale: "Add provider metadata.",
        },
        {
          path: "scripts/run.mjs",
          charCount: 19,
          language: "javascript",
        },
      ],
    });
    expect(parsed.longformInputPreview).toMatchObject({
      title: "Repair files",
      runningTitle: "Applying repair",
      summary: "ambient-elevenlabs-tts · 2 files · 1,737 chars",
      items: [
        { label: "File 1", fieldPath: "files[0].content", path: "ambient-cli.json", chars: 1718, truncated: true },
        { label: "File 2", fieldPath: "files[1].content", path: "scripts/run.mjs", chars: 19, truncated: false },
      ],
    });
  });

  it("parses structured long-string fallback previews for apply-repair files", () => {
    const parsed = parseToolMessage(
      [
        "ambient_capability_builder_apply_repair preparing",
        "",
        "Input",
        JSON.stringify(
          {
            packageName: "ambient-elevenlabs-tts",
            files: [
              {
                path: "ambient-cli.json",
                content: {
                  preview: '{"name":"ambient-elevenlabs-tts"}\n... (1718 chars total)',
                  chars: 1718,
                  truncated: true,
                  omittedChars: 1691,
                },
              },
              {
                path: "scripts/run.mjs",
                content: {
                  preview: "console.log('ok');\n... (2200 chars total)",
                  chars: 2200,
                  truncated: true,
                  omittedChars: 2182,
                },
              },
            ],
          },
          null,
          2,
        ),
      ].join("\n"),
      "ambient_capability_builder_apply_repair",
      "/workspace",
    );

    expect(parsed.preview).toBe("ambient-elevenlabs-tts · 2 files · 3,918 chars");
    expect(parsed.longformInputPreview).toMatchObject({
      summary: "ambient-elevenlabs-tts · 2 files · 3,918 chars",
      items: [
        { path: "ambient-cli.json", chars: 1718, truncated: true },
        { path: "scripts/run.mjs", chars: 2200, truncated: true },
      ],
    });
  });

  it("uses metadata longform previews when visible input is structurally truncated", () => {
    const parsed = parseToolMessage(
      ["ambient_capability_builder_apply_repair preparing", "", "Input", '{ "packageName": "ambient-elevenlabs-tts", "files": ['].join(
        "\n",
      ),
      "ambient_capability_builder_apply_repair",
      "/workspace",
      {
        toolLongformInputPreview: {
          kind: "longform-input",
          title: "Repair files",
          runningTitle: "Applying repair",
          summary: "ambient-elevenlabs-tts · 2 files · 2,400 chars",
          items: [
            {
              label: "File 1",
              fieldPath: "files[0].content",
              path: "ambient-cli.json",
              language: "json",
              preview: "{}",
              chars: 1200,
              truncated: true,
            },
            {
              label: "File 2",
              fieldPath: "files[1].content",
              path: "scripts/run.mjs",
              language: "javascript",
              preview: "console.log('ok');",
              chars: 1200,
              truncated: true,
            },
          ],
        },
      },
    );

    expect(parsed.preview).toBe("ambient-elevenlabs-tts · 2 files · 2,400 chars");
    expect(parsed.longformInputPreview?.items.map((item) => item.path)).toEqual(["ambient-cli.json", "scripts/run.mjs"]);
    expect(parsed.applyRepairPreview).toBeUndefined();
  });

  it("keeps single-file write char counts in the file row only", () => {
    const parsed = parseToolMessage(
      ["write preparing", "", "Input", '{ "path": "src/generated.ts", "content": "'].join("\n"),
      "write",
      "/workspace",
      {
        toolLongformInputPreview: {
          kind: "longform-input",
          title: "Input",
          runningTitle: "Writing",
          summary: "src/generated.ts · 1,200 chars",
          items: [
            {
              label: "File",
              fieldPath: "content",
              path: "src/generated.ts",
              language: "typescript",
              preview: "a".repeat(20),
              chars: 1200,
              truncated: true,
            },
          ],
        },
      },
    );

    expect(parsed.preview).toBe("src/generated.ts");
    expect(parsed.preview).not.toContain("1,200 chars");
    expect(parsed.longformInputPreview).toBeTruthy();
    expect(toolLongformInputPreviewDisplaySummary(parsed.longformInputPreview!)).toBe("src/generated.ts");
    expect(parsed.longformInputPreview?.items[0]?.chars).toBe(1200);
  });

  it("uses workflow longform metadata for playbook update cards", () => {
    const parsed = parseToolMessage(
      [
        "ambient_workflows_update preparing",
        "",
        "Input",
        JSON.stringify({ type: "object", keys: ["baseVersion", "id", "draft"], totalKeys: 3, truncated: true }, null, 2),
      ].join("\n"),
      "ambient_workflows_update",
      "/workspace",
      {
        toolLongformInputPreview: {
          kind: "longform-input",
          title: "Workflow update",
          runningTitle: "Updating workflow playbook",
          summary: "Find date-night theatre events · base v3 · 2 examples · 1 do-not patterns",
          items: [
            {
              label: "Intent",
              fieldPath: "draft.intent",
              preview: "Find date-night theatre events.",
              chars: 31,
              truncated: false,
            },
          ],
        },
      },
    );

    expect(parsed.preview).toBe("Find date-night theatre events · base v3 · 2 examples · 1 do-not patterns");
    expect(parsed.longformInputPreview).toMatchObject({
      title: "Workflow update",
      runningTitle: "Updating workflow playbook",
      items: [{ label: "Intent", fieldPath: "draft.intent" }],
    });
  });

  it("renders compact workflow management input summaries", () => {
    const update = parseToolMessage(
      [
        "ambient_workflows_update preparing",
        "",
        "Input",
        JSON.stringify(
          {
            id: "workflow-date-night",
            baseVersion: 3,
            draft: { intent: "Find date-night theatre events." },
          },
          null,
          2,
        ),
      ].join("\n"),
      "ambient_workflows_update",
      "/workspace",
    );
    const archive = parseToolMessage(
      [
        "ambient_workflows_archive preparing",
        "",
        "Input",
        JSON.stringify({ id: "workflow-date-night", baseVersion: 4, reason: "superseded" }, null, 2),
      ].join("\n"),
      "ambient_workflows_archive",
      "/workspace",
    );

    expect(update.preview).toBe("Find date-night theatre events. · base v3 · draft update");
    expect(archive.preview).toBe("workflow-date-night · base v4 · superseded");
  });

  it("surfaces streamed argument status from tool metadata", () => {
    const parsed = parseToolMessage(
      ["write preparing", "", "Input", '{ "path": "plan.md", "content": "'].join("\n"),
      "write",
      "/workspace",
      {
        toolArgumentProgress: {
          version: 1,
          phase: "argument_stream",
          eventType: "toolcall_delta",
          toolCallId: "call-1",
          toolName: "write",
          uiStatus: "write is streaming a large argument (12,000 chars).",
          argumentStartedAt: "2026-05-21T10:00:00.000Z",
          argumentUpdatedAt: "2026-05-21T10:00:02.000Z",
          argumentElapsedMs: 2000,
          argumentComplete: false,
          inputChars: 12000,
          deltaChars: 12000,
          totalDeltaChars: 12000,
          maxDeltaChars: 12000,
          argumentEventCount: 2,
          toolcallDeltaCount: 1,
          meaningfulGrowthCount: 1,
          charsPerSecond: 6000,
        },
      },
    );

    expect(parsed.argumentStatus).toBe("write is streaming a large argument (12,000 chars).");
    expect(parsed.argumentProgress).toMatchObject({
      phase: "argument_stream",
      inputChars: 12000,
    });
  });

  it("renders generic running tool progress without counting heartbeat text as output", () => {
    const result = "Still planning MCP autowire for https://github.com/example/repo (2m 20s elapsed).";
    const parsed = parseToolMessage(
      [
        "ambient_mcp_autowire_plan running",
        "",
        "Input",
        JSON.stringify({ allowedDiscovery: { maxFetches: 8, search: true }, targetUrl: "https://github.com/example/repo" }, null, 2),
        "",
        "Result",
        result,
      ].join("\n"),
      "ambient_mcp_autowire_plan",
      "/workspace",
      {
        toolArgumentProgress: {
          version: 1,
          phase: "execution",
          eventType: "tool_execution_start",
          toolCallId: "call-autowire",
          toolName: "ambient_mcp_autowire_plan",
          uiStatus: "ambient_mcp_autowire_plan is executing (203 chars).",
          argumentStartedAt: "2026-06-07T19:20:00.000Z",
          argumentUpdatedAt: "2026-06-07T19:20:00.000Z",
          argumentElapsedMs: 1000,
          argumentComplete: true,
          inputChars: 203,
          deltaChars: 0,
          totalDeltaChars: 203,
          maxDeltaChars: 203,
          observedArgumentChars: 203,
          argumentEventCount: 2,
          toolcallDeltaCount: 1,
          meaningfulGrowthCount: 1,
          charsPerSecond: 203,
          executionElapsedMs: 140_000,
        },
        toolResultDetails: {
          runtime: "ambient-mcp",
          toolName: "ambient_mcp_autowire_plan",
          status: "planning",
          stage: "heartbeat",
          targetUrl: "https://github.com/example/repo",
          elapsedMs: 140_000,
          heartbeatCount: 28,
        },
      },
    );

    expect(parsed.progressPreview).toMatchObject({
      title: "Progress",
      summary: expect.stringContaining("Planning · Heartbeat · 2m 20s · 203 chars"),
      rows: expect.arrayContaining([
        { key: "state", label: "State", value: "Planning" },
        { key: "stage", label: "Stage", value: "Heartbeat" },
        { key: "input", label: "Input", value: "203 chars" },
        { key: "elapsed", label: "Elapsed", value: "2m 20s" },
        { key: "updates", label: "Updates", value: "28" },
        { key: "target", label: "Target", value: "https://github.com/example/repo" },
      ]),
    });
    expect(parsed.progressPreview?.summary).not.toContain(`${result.length.toLocaleString()} output chars`);
    expect(parsed.progressPreview?.rows).not.toContainEqual({
      key: "output",
      label: "Output",
      value: `${result.length.toLocaleString()} chars`,
    });
    expect(parsed.longformInputPreview).toBeUndefined();
  });

  it("renders Local Deep Research status snapshots as meaningful progress", () => {
    const parsed = parseToolMessage(
      [
        "ambient_local_deep_research_run running",
        "",
        "Input",
        JSON.stringify({ question: "Research authorial voice." }, null, 2),
        "",
        "Result",
        "Local Deep Research is still running.",
      ].join("\n"),
      "ambient_local_deep_research_run",
      "/workspace",
      {
        toolResultDetails: {
          runtime: "ambient-local-deep-research",
          toolName: "ambient_local_deep_research_run",
          status: "running",
          stage: "model-turn",
          activityMessage: "LiteResearcher model turn 2/6 is running.",
          elapsedMs: 75_000,
          heartbeatCount: 7,
          localDeepResearchStatus: {
            schemaVersion: "ambient-local-deep-research-status-v1",
            stage: "model-turn",
            state: "running",
            message: "LiteResearcher model turn 2/6 is running.",
            elapsedMs: 75_000,
            heartbeatCount: 7,
            turn: {
              turn: 2,
              maxTurns: 6,
              toolCalls: 3,
              maxToolCalls: 6,
            },
            retrieval: {
              role: "fetch",
              status: "succeeded",
              providerLabel: "Scrapling MCP",
              url: "https://example.com/voice",
              outputChars: 4321,
              durationMs: 1800,
              repeatedVisitCount: 2,
            },
            llamaServer: {
              pid: 1234,
              endpointUrl: "http://127.0.0.1:57188",
              profileId: "literesearcher-4b-q4-k-m",
              healthy: true,
              healthLatencyMs: 42,
              rssBytes: 9_900_000_000,
            },
            memory: {
              policyOutcome: "warn",
              policyReason: "Projected local-model launch over policy.",
              activeLocalModelCount: 2,
              activeEstimatedResidentMemoryBytes: 16_106_127_360,
              activeActualResidentMemoryBytes: 8_375_000_000,
              projectedSystemMemoryUtilization: 1,
              maxProjectedMemoryUtilization: 0.8,
              projectedFreeMemoryBytes: 0,
              hostFreeMemoryBytes: 2_147_483_648,
              swapUsedBytes: 3_758_096_384,
              compressedMemoryBytes: 1_412_050_944,
              warnings: ["Projected local-model launch over policy."],
            },
            artifacts: {
              markdownPath: ".ambient/local-deep-research/runs/latest.md",
            },
          },
        },
      },
    );

    expect(parsed.progressPreview).toMatchObject({
      title: "Progress",
      summary: expect.stringContaining("LiteResearcher model turn 2/6 is running."),
      rows: expect.arrayContaining([
        { key: "turn", label: "Turn", value: "2/6 · 3/6 tools" },
        { key: "retrieval", label: "Retrieval", value: "Fetch · Succeeded · repeat 2" },
        { key: "provider", label: "Provider", value: "Scrapling MCP" },
        { key: "server", label: "llama.cpp", value: expect.stringContaining("healthy") },
        { key: "rss", label: "Server RSS", value: expect.stringContaining("GiB") },
        { key: "memory-policy", label: "Memory policy", value: expect.stringContaining("Warn") },
        { key: "projected-use", label: "Projected use", value: expect.stringContaining("100% projected") },
        { key: "swap", label: "Swap used", value: expect.stringContaining("GiB") },
        { key: "artifacts", label: "Artifacts", value: ".ambient/local-deep-research/runs/latest.md" },
      ]),
    });
  });

  it("keeps Local Deep Research argument streaming separate from run status progress", () => {
    const parsed = parseToolMessage(
      [
        "ambient_local_deep_research_run running",
        "",
        "Input",
        JSON.stringify({ question: "Research authorial voice." }, null, 2),
        "",
        "Result",
        "Preparing Local Deep Research run.",
      ].join("\n"),
      "ambient_local_deep_research_run",
      "/workspace",
      {
        toolArgumentProgress: {
          version: 1,
          phase: "execution",
          eventType: "toolcall_delta",
          toolCallId: "call-1",
          toolName: "ambient_local_deep_research_run",
          uiStatus: "ambient_local_deep_research_run is executing (354 chars).",
          argumentStartedAt: "2026-06-16T12:30:00.000Z",
          argumentUpdatedAt: "2026-06-16T12:33:00.000Z",
          argumentElapsedMs: 2000,
          executionStartedAt: "2026-06-16T12:30:00.000Z",
          executionElapsedMs: 180_000,
          argumentComplete: true,
          inputChars: 354,
          argumentEventCount: 77,
        },
        toolResultDetails: {
          runtime: "ambient-local-deep-research",
          toolName: "ambient_local_deep_research_run",
          status: "running",
          stage: "preparing",
          elapsedMs: 0,
          localDeepResearchStatus: {
            schemaVersion: "ambient-local-deep-research-status-v1",
            stage: "preparing",
            state: "running",
            message: "Preparing Local Deep Research run.",
            elapsedMs: 0,
          },
        },
      },
    );

    expect(parsed.progressPreview).toMatchObject({
      rows: expect.arrayContaining([
        { key: "elapsed", label: "Elapsed", value: "3m" },
        { key: "argument-updates", label: "Argument updates", value: "77" },
      ]),
    });
    expect(parsed.progressPreview?.rows).not.toContainEqual({ key: "updates", label: "Updates", value: "77" });
  });

  it("prefers explicit progress metrics over heartbeat result text length", () => {
    const parsed = parseToolMessage(
      [
        "ambient_mcp_standard_import_install running",
        "",
        "Input",
        JSON.stringify({ candidateRef: "ambient-mcp-candidate:example" }, null, 2),
        "",
        "Result",
        "Waiting for Ambient Desktop approval: Install MCP server?",
      ].join("\n"),
      "ambient_mcp_standard_import_install",
      "/workspace",
      {
        toolResultDetails: {
          runtime: "ambient-permission",
          toolName: "ambient_mcp_standard_import_install",
          status: "awaiting-approval",
          stage: "approval",
          waitingOn: "desktop-approval",
          elapsedMs: 15_000,
          outputChars: 4096,
          thinkingChars: 512,
          heartbeatCount: 4,
          approvalRequestId: "request-1",
          approvalTitle: "Install MCP server?",
        },
      },
    );

    expect(parsed.progressPreview).toMatchObject({
      summary: expect.stringContaining("4,096 output chars"),
      rows: expect.arrayContaining([
        { key: "output", label: "Output", value: "4,096 chars" },
        { key: "thinking", label: "Thinking", value: "512 chars" },
        { key: "waiting-on", label: "Waiting on", value: "Desktop Approval" },
        { key: "approval", label: "Approval", value: "Install MCP server?" },
      ]),
    });
  });

  it("parses install route summaries into a transcript preview model", () => {
    const parsed = parseToolMessage(
      [
        "ambient_install_route_plan completed",
        "",
        "Input",
        JSON.stringify({ userRequest: "Install this Codex plugin marketplace entry." }, null, 2),
        "",
        "Result",
        [
          "Ambient install route plan",
          "Lane: unsupported",
          "Confidence: high",
          "Reason: Plugin marketplace and local plugin installs are intentionally hidden until this product surface is supported.",
          "",
          "Next tools:",
          "- none",
          "",
          "Approval boundary: none-readonly",
          "",
          "Blockers:",
          "- Plugin marketplace and local plugin installs are not currently supported as active install routes.",
          "",
          "Warnings:",
          "- Do not call ambient_plugin_install_preview, ambient_plugin_install_commit, or ambient_plugin_activate for this request.",
        ].join("\n"),
      ].join("\n"),
      "ambient_install_route_plan",
      "/workspace",
      {
        toolResultDetails: {
          installRouteSummary: {
            kind: "ambient-install-route-summary",
            lane: "unsupported",
            confidence: "high",
            reason: "Plugin marketplace and local plugin installs are intentionally hidden until this product surface is supported.",
            approvalBoundary: "none-readonly",
            nextTools: [],
            blockers: ["Plugin marketplace and local plugin installs are not currently supported as active install routes."],
            warnings: [
              "Do not call ambient_plugin_install_preview, ambient_plugin_install_commit, or ambient_plugin_activate for this request.",
            ],
            validationTarget: {
              kind: "route-only",
              description: "Refuse the unsupported plugin install route; do not call plugin install tools.",
            },
          },
        },
      },
    );

    expect(parsed.installRoutePreview).toEqual({
      lane: "unsupported",
      confidence: "high",
      reason: "Plugin marketplace and local plugin installs are intentionally hidden until this product surface is supported.",
      approvalBoundary: "none-readonly",
      nextTools: [],
      blockers: ["Plugin marketplace and local plugin installs are not currently supported as active install routes."],
      warnings: ["Do not call ambient_plugin_install_preview, ambient_plugin_install_commit, or ambient_plugin_activate for this request."],
      validationKind: "route-only",
      validationDescription: "Refuse the unsupported plugin install route; do not call plugin install tools.",
    });
  });

  it("parses modern edit tool messages into edit previews with result diffs", () => {
    const parsed = parseToolMessage(
      [
        "edit completed",
        "",
        "Input",
        JSON.stringify(
          { path: "/workspace/src/app.ts", edits: [{ oldText: 'const label = "old";', newText: 'const label = "new";' }] },
          null,
          2,
        ),
        "",
        "Result",
        "Successfully replaced 1 block(s) in src/app.ts.",
      ].join("\n"),
      "edit",
      "/workspace",
      {
        toolResultDetails: {
          diff: '-2 const label = "old";\n+2 const label = "new";',
          firstChangedLine: 2,
        },
      },
    );

    expect(parsed.artifactPath).toBe("src/app.ts");
    expect(parsed.writePreview).toBeUndefined();
    expect(parsed.editPreview).toEqual({
      path: "/workspace/src/app.ts",
      edits: [{ oldText: 'const label = "old";', newText: 'const label = "new";' }],
      diff: '-2 const label = "old";\n+2 const label = "new";',
      firstChangedLine: 2,
      language: "typescript",
    });
  });

  it("supports legacy and stringified edit argument shapes", () => {
    const legacy = parseToolMessage(
      ["edit prepared", "", "Input", JSON.stringify({ path: "README.md", oldText: "  old\n", newText: "" }, null, 2)].join("\n"),
      "edit",
      "/workspace",
    );
    expect(legacy.editPreview?.edits).toEqual([{ oldText: "  old\n", newText: "" }]);

    const stringified = parseToolMessage(
      [
        "edit prepared",
        "",
        "Input",
        JSON.stringify({ path: "README.md", edits: JSON.stringify([{ oldText: "before", newText: "after" }]) }, null, 2),
      ].join("\n"),
      "edit",
      "/workspace",
    );
    expect(stringified.editPreview?.edits).toEqual([{ oldText: "before", newText: "after" }]);
  });

  it("prefers structured edit input metadata over bounded raw JSON", () => {
    const parsed = parseToolMessage(
      [
        "edit preparing",
        "",
        "Input",
        JSON.stringify(
          {
            path: "src/app.ts",
            edits: [
              {
                oldText: { preview: "raw bounded old", chars: 1300, truncated: true, omittedChars: 100 },
                newText: { preview: "raw bounded new", chars: 1400, truncated: true, omittedChars: 200 },
              },
            ],
          },
          null,
          2,
        ),
      ].join("\n"),
      "edit",
      "/workspace",
      {
        toolEditInputPreview: {
          kind: "edit-input",
          summary: "src/app.ts · 1 replacement · 2,700 chars",
          path: "src/app.ts",
          language: "typescript",
          edits: [
            {
              oldText: { preview: "metadata old preview", chars: 1300, truncated: true, omittedChars: 300 },
              newText: { preview: "metadata new preview", chars: 1400, truncated: false },
            },
          ],
        },
      },
    );

    expect(parsed.editPreview).toEqual({
      path: "src/app.ts",
      language: "typescript",
      edits: [
        {
          oldText: "metadata old preview",
          oldTextChars: 1300,
          oldTextTruncated: true,
          oldTextOmittedChars: 300,
          newText: "metadata new preview",
          newTextChars: 1400,
        },
      ],
    });
  });

  it("parses bounded edit input JSON as a fallback preview", () => {
    const parsed = parseToolMessage(
      [
        "edit preparing",
        "",
        "Input",
        JSON.stringify(
          {
            path: "ambient-cli.json",
            edits: [
              {
                oldText: {
                  preview: '"modelAssets": [\n  {\n    "name": "Piper en_US lessac medium ONNX voice"\n... (689 chars total)',
                  chars: 689,
                  truncated: true,
                  omittedChars: 449,
                },
                newText: {
                  preview: '"modelAssets": [\n  {\n    "name": "Piper en_US ryan high ONNX voice"\n... (1257 chars total)',
                  chars: 1257,
                  truncated: true,
                  omittedChars: 1017,
                },
              },
            ],
          },
          null,
          2,
        ),
      ].join("\n"),
      "edit",
      "/workspace",
    );

    expect(parsed.editPreview?.path).toBe("ambient-cli.json");
    expect(parsed.editPreview?.edits).toMatchObject([
      {
        oldTextChars: 689,
        oldTextTruncated: true,
        oldTextOmittedChars: 449,
        newTextChars: 1257,
        newTextTruncated: true,
        newTextOmittedChars: 1017,
      },
    ]);
    expect(parsed.editPreview?.edits[0]?.oldText).toContain("Piper en_US lessac medium");
    expect(parsed.editPreview?.edits[0]?.newText).toContain("Piper en_US ryan high");
  });

  it("collects artifact hints from write and edit tool messages", () => {
    const messages: ChatMessage[] = [
      toolMessage("write", ["write completed", "", "Input", JSON.stringify({ path: "src/generated.ts", content: "ok" })].join("\n")),
      toolMessage(
        "edit",
        ["edit completed", "", "Input", JSON.stringify({ path: "src/app.ts", edits: [{ oldText: "a", newText: "b" }] })].join("\n"),
      ),
    ];

    const hints = collectArtifactPathHints(messages, "/workspace");
    expect(resolveInlineArtifactPath("generated.ts", hints)).toBe("src/generated.ts");
    expect(resolveInlineArtifactPath("src/app.ts", hints)).toBe("src/app.ts");
  });

  it("surfaces managed MCP output files as previewable workspace artifacts", () => {
    const workspacePath = "/Users/travis/ambientCoder";
    const workspaceArtifactPath = ".ambient/mcp-outputs/2026-06-10/ambient-csvglow-standard-mcp-csvglow.html";
    const metadata = {
      toolName: "ambient_mcp_tool_call",
      status: "done",
      toolResultDetails: {
        runtime: "ambient-mcp",
        toolName: "ambient_mcp_tool_call",
        status: "complete",
        managedFileArtifacts: [
          {
            source: "output-path",
            filename: "csvglow.html",
            bytes: 1058312,
            containerPath: "/ambient/mcp-files/csvglow.html",
            hostPath: "/Users/travis/Library/Application Support/Ambient Desktop/mcp/toolhive/file-exchange/csvglow.html",
            workspacePath: `${workspacePath}/${workspaceArtifactPath}`,
          },
        ],
      },
    };
    const content = ["ambient_mcp_tool_call completed", "", "Result", "MCP tool csvglow-standard-mcp/generate_dashboard completed."].join(
      "\n",
    );

    const parsed = parseToolMessage(content, "ambient_mcp_tool_call", workspacePath, metadata);

    expect(parsed.artifactPath).toBe(workspaceArtifactPath);
    expect(parsed.managedFileArtifacts).toEqual([
      {
        source: "output-path",
        filename: "csvglow.html",
        bytes: 1058312,
        containerPath: "/ambient/mcp-files/csvglow.html",
        hostPath: "/Users/travis/Library/Application Support/Ambient Desktop/mcp/toolhive/file-exchange/csvglow.html",
        workspacePath: workspaceArtifactPath,
      },
    ]);

    const hints = collectArtifactPathHints(
      [
        {
          id: "managed-mcp-artifact-message",
          threadId: "thread",
          role: "tool",
          content,
          createdAt: "2026-06-10T00:00:00.000Z",
          metadata,
        },
      ],
      workspacePath,
    );
    expect(resolveInlineArtifactPath(workspaceArtifactPath, hints, workspacePath)).toBe(workspaceArtifactPath);
    expect(resolveInlineArtifactPath("ambient-csvglow-standard-mcp-csvglow.html", hints, workspacePath)).toBe(workspaceArtifactPath);
  });

  it("resolves absolute workspace paths in inline code as artifact links", () => {
    const workspacePath = "/Users/travis/Documents/ambientCoderArchive";

    expect(resolveInlineArtifactPath("/Users/travis/Documents/ambientCoderArchive/pdf-summaries.html", undefined, workspacePath)).toBe(
      "pdf-summaries.html",
    );
    expect(
      resolveInlineArtifactPath("file:///Users/travis/Documents/ambientCoderArchive/reports/summary.html", undefined, workspacePath),
    ).toBe("reports/summary.html");
    expect(resolveInlineArtifactPath("/Users/travis/Downloads/outside-summary.html", undefined, workspacePath)).toBeUndefined();
  });

  it("resolves explicit workspace-relative inline code paths as artifact links", () => {
    const workspacePath = "/Users/travis/Documents/ambientCoderArchive";

    expect(
      resolveInlineArtifactPath(".ambient/local-deep-research/runs/2026-06-08T04-39-41-114Z-e85bd214d299.md", undefined, workspacePath),
    ).toBe(".ambient/local-deep-research/runs/2026-06-08T04-39-41-114Z-e85bd214d299.md");
    expect(resolveInlineArtifactPath("reports/summary.html", undefined, workspacePath)).toBe("reports/summary.html");
    expect(resolveInlineArtifactPath("../outside.md", undefined, workspacePath)).toBeUndefined();
    expect(resolveInlineArtifactPath("https://example.com/report.md", undefined, workspacePath)).toBeUndefined();
  });

  it("does not treat shell commands ending with dotted values as artifact paths", () => {
    const command = "ssh-copy-id -i ~/.ssh/rtx6000_ed25519.pub <rtx_user>@100.99.88.49";

    expect(resolveInlineArtifactPath(command, undefined, "/workspace")).toBeUndefined();
  });

  it("recognizes explicit media artifacts emitted by shell tools", () => {
    const parsed = parseToolMessage(
      [
        "bash completed",
        "",
        "Command",
        "node generate-media.mjs",
        "",
        "Result",
        "Created notes.txt",
        "Generated media artifact: ./artifacts/live-tone.wav",
      ].join("\n"),
      "bash",
      "/workspace",
    );

    expect(parsed.artifactPath).toBe("./artifacts/live-tone.wav");
  });

  it("routes absolute generated artifact paths through local preview", () => {
    expect(artifactPreviewRoute("/tmp/ambient-test/workspace/calculator.html")).toEqual({ kind: "local-file" });
    expect(artifactPreviewRoute("C:\\Users\\tester\\workspace\\calculator.html")).toEqual({ kind: "local-file" });
    expect(artifactPreviewRoute("\\\\server\\share\\calculator.html")).toEqual({ kind: "local-file" });
    expect(artifactPreviewRoute("calculator.html")).toEqual({ kind: "workspace-file" });
    expect(artifactPreviewRoute(".ambient-codex/browser/screenshots/browser.png")).toEqual({
      kind: "workspace-media",
      mediaKind: "image",
    });
  });

  it("recognizes structured media artifact metadata for first-party media tools", () => {
    const parsed = parseToolMessage(
      [
        "media_download completed",
        "",
        "Input",
        JSON.stringify({ url: "https://example.test/bunny.jpg", outputPath: "bunny.jpg" }, null, 2),
        "",
        "Result",
        "Generated media artifact: bunny.jpg",
      ].join("\n"),
      "media_download",
      "/workspace",
      {
        toolResultDetails: {
          mediaArtifact: {
            artifactPath: "bunny.jpg",
            mediaKind: "image",
            mimeType: "image/jpeg",
            bytes: 2048,
            inlinePreviewEligible: true,
            displayInstruction: "Ambient Desktop will attempt to render this media inline in the visible chat.",
          },
        },
      },
    );

    expect(parsed.artifactPath).toBe("bunny.jpg");
  });

  it("normalizes workspace media artifact paths that lost the leading absolute slash", () => {
    const workspacePath = "/Users/example/Documents/ambientCoder-main-icon-tour/.ambient-codex/worktrees/thread";
    const parsed = parseToolMessage(
      ["media_download completed", "", "Result", "Generated media artifact: google-2026-06-16T05-18-43-439Z.png"].join("\n"),
      "media_download",
      workspacePath,
      {
        toolResultDetails: {
          mediaArtifact: {
            artifactPath: `Users/Neo/Documents/ambientCoder-main-icon-tour/.ambient-codex/worktrees/thread/.ambient/hosted-images/google-2026-06-16T05-18-43-439Z.png`,
            mediaKind: "image",
            mimeType: "image/jpeg",
            bytes: 2048,
            inlinePreviewEligible: true,
            displayInstruction: "Ambient Desktop will attempt to render this media inline in the visible chat.",
          },
        },
      },
    );

    expect(parsed.artifactPath).toBe(".ambient/hosted-images/google-2026-06-16T05-18-43-439Z.png");
  });

  it("recognizes structured browser screenshot media metadata", () => {
    const parsed = parseToolMessage(
      [
        "browser_screenshot completed",
        "",
        "Input",
        JSON.stringify({ profileMode: "isolated" }, null, 2),
        "",
        "Result",
        "Browser screenshot captured.",
      ].join("\n"),
      "browser_screenshot",
      "/workspace",
      {
        mediaArtifact: {
          artifactPath: ".ambient-codex/browser/screenshots/browser.png",
          mediaKind: "image",
          mimeType: "image/png",
          bytes: 4096,
          width: 1280,
          height: 720,
          inlinePreviewEligible: true,
          displayInstruction: "Ambient Desktop will attempt to render this browser screenshot inline in the visible chat.",
        },
      },
    );

    expect(parsed.artifactPath).toBe(".ambient-codex/browser/screenshots/browser.png");
  });

  it("does not treat generic shell paths as generated media artifacts", () => {
    const parsed = parseToolMessage(
      ["bash completed", "", "Command", "ls -1", "", "Result", "src/app.ts\nREADME.md"].join("\n"),
      "bash",
      "/workspace",
    );

    expect(parsed.artifactPath).toBeUndefined();
  });

  it("recognizes media artifacts reported by ambient cli results", () => {
    const parsed = parseToolMessage(
      [
        "ambient_cli completed",
        "",
        "Input",
        JSON.stringify(
          { packageName: "ambient-neutts", command: "tts", args: ["--text", "The rain in Spain is falling down the plain"] },
          null,
          2,
        ),
        "",
        "Result",
        "Live Test Results",
        "",
        "Detail\tValue",
        'Input text\t"The rain in Spain is falling down the plain"',
        "Output file\tneutts-rain-spain.wav",
        "Duration\t2.88 seconds",
        "The WAV file is at neutts-rain-spain.wav in the workspace.",
      ].join("\n"),
      "ambient_cli",
      "/workspace",
    );

    expect(parsed.artifactPath).toBe("neutts-rain-spain.wav");
    expect(artifactMediaKindFromPath(parsed.artifactPath!)).toBe("audio");
  });

  it("recognizes ambient cli JSON stdout media outputs relative to the command cwd", () => {
    const parsed = parseToolMessage(
      [
        "ambient_cli completed",
        "",
        "Result",
        "Ambient CLI completed",
        "Package: ambient-neutts",
        "Command: tts",
        "Cwd: /workspace/.ambient/cli-packages/imported/ambient-neutts-0.1.0",
        "Duration: 23862ms",
        "Stdout:",
        "Loading NeuTTS...",
        "Synthesizing: I cant believe this actually worked",
        '{"status":"ok","output":"neutts-cant-believe.wav","sample_rate":24000,"duration_sec":1.34}',
      ].join("\n"),
      "ambient_cli",
      "/workspace",
    );

    expect(parsed.artifactPath).toBe(".ambient/cli-packages/imported/ambient-neutts-0.1.0/neutts-cant-believe.wav");
    expect(artifactMediaKindFromPath(parsed.artifactPath!)).toBe("audio");
  });

  it("recognizes pretty-printed ambient cli JSON output paths without dropping absolute path roots", () => {
    const workspacePath = "/Users/example/Documents/ambientCoder-main-icon-tour/.ambient-codex/worktrees/thread-1";
    const parsed = parseToolMessage(
      [
        "ambient_cli completed",
        "",
        "Result",
        "Ambient CLI completed",
        "Package: ambient-imagegen",
        "Command: hosted_image_generate",
        `Cwd: ${workspacePath}`,
        "Duration: 27744ms",
        "Stdout:",
        JSON.stringify(
          {
            packageName: "ambient-imagegen",
            status: "generated",
            outputPath: `${workspacePath}/.ambient/hosted-images/google-4k.jpg`,
            metadataPath: `${workspacePath}/.ambient/hosted-images/google-4k.jpg.json`,
            image: { mimeType: "image/jpeg", bytes: 10371871, width: 5632, height: 3072 },
          },
          null,
          2,
        ),
      ].join("\n"),
      "ambient_cli",
      workspacePath,
    );

    expect(parsed.artifactPath).toBe(".ambient/hosted-images/google-4k.jpg");
  });

  it("repairs stored artifact metadata that lost the leading slash from an absolute workspace path", () => {
    const workspacePath = "/Users/example/Documents/ambientCoder-main-icon-tour/.ambient-codex/worktrees/thread-1";
    const parsed = parseToolMessage(
      ["ambient_cli completed", "", "Result", "Ambient CLI completed", "Stdout:", JSON.stringify({ status: "generated" })].join("\n"),
      "ambient_cli",
      workspacePath,
      {
        artifactPath:
          "Users/Neo/Documents/ambientCoder-main-icon-tour/.ambient-codex/worktrees/thread-1/.ambient/hosted-images/google-4k.jpg",
      },
    );

    expect(parsed.artifactPath).toBe(".ambient/hosted-images/google-4k.jpg");
  });

  it("recognizes ambient cli audioPath JSON stdout without duplicating absolute workspace paths", () => {
    const workspacePath = "/Users/example/.ambient-hardening/bases/example-core-no-secrets/workspace";
    const packageRoot = `${workspacePath}/.ambient/cli-packages/imported/ambient-cartesia-0.1.0`;
    const parsed = parseToolMessage(
      [
        "ambient_cli completed",
        "",
        "Result",
        "Ambient CLI completed",
        "Package: ambient-cartesia",
        "Command: tts",
        `Cwd: ${packageRoot}`,
        "Duration: 23862ms",
        "Stdout:",
        JSON.stringify({ audioPath: `${packageRoot}/wuthering-katie.wav`, mimeType: "audio/wav", providerId: "cartesia" }),
      ].join("\n"),
      "ambient_cli",
      workspacePath,
    );

    expect(parsed.artifactPath).toBe(".ambient/cli-packages/imported/ambient-cartesia-0.1.0/wuthering-katie.wav");
    expect(artifactMediaKindFromPath(parsed.artifactPath!)).toBe("audio");
  });

  it("normalizes absolute ambient cli media artifact paths", () => {
    const parsed = parseToolMessage(
      [
        "ambient_cli completed",
        "",
        "Input",
        JSON.stringify({ packageName: "ambient-video", command: "render" }),
        "",
        "Result",
        "Saved output file: /workspace/renders/demo.webm",
      ].join("\n"),
      "ambient_cli",
      "/workspace",
    );

    expect(parsed.artifactPath).toBe("renders/demo.webm");
  });

  it("does not treat generic ambient cli output as a generated media artifact", () => {
    const parsed = parseToolMessage(
      [
        "ambient_cli completed",
        "",
        "Input",
        JSON.stringify({ packageName: "ambient-json-cli", command: "json-pick" }),
        "",
        "Result",
        "message",
      ].join("\n"),
      "ambient_cli",
      "/workspace",
    );

    expect(parsed.artifactPath).toBeUndefined();
  });

  it("uses large-output metadata for result preview summaries", () => {
    const parsed = parseToolMessage(
      ["ambient_cli completed", "", "Result", "Ambient CLI completed\nStdout:\npreview text"].join("\n"),
      "ambient_cli",
      "/workspace",
      {
        toolResultDetails: {
          largeOutputPreview: {
            kind: "large-output",
            summary: "stdout · 17,000 chars · 16,000 preview · full output: .ambient/tool-outputs/stdout.txt",
            items: [
              {
                label: "stdout",
                chars: 17000,
                previewChars: 16000,
                truncated: true,
                artifactPath: ".ambient/tool-outputs/stdout.txt",
                artifactBytes: 17123,
                suggestedTools: ["file_read", "long_context_process"],
              },
            ],
          },
        },
      },
    );

    expect(parsed.resultPreview).toBe("stdout · 17,000 chars · 16,000 preview · full output: .ambient/tool-outputs/stdout.txt");
    expect(parsed.largeOutputPreview).toMatchObject({
      kind: "large-output",
      items: [
        {
          label: "stdout",
          chars: 17000,
          previewChars: 16000,
          artifactPath: ".ambient/tool-outputs/stdout.txt",
        },
      ],
    });
  });

  it("builds display rows for the large-output summary block", () => {
    const model = toolLargeOutputPreviewViewModel({
      kind: "large-output",
      summary: "2 outputs · 24,500 chars · 1 full output artifact",
      items: [
        {
          label: "stdout",
          chars: 17000,
          previewChars: 12000,
          truncated: true,
          artifactPath: ".ambient/tool-outputs/stdout.txt",
          artifactBytes: 17123,
          suggestedTools: ["file_read", "long_context_process"],
        },
        {
          label: "stderr",
          chars: 7500,
          previewChars: 7500,
          truncated: false,
        },
      ],
    });

    expect(model).toEqual({
      title: "Output",
      summary: "2 outputs · 24,500 chars · 1 full output artifact",
      rows: [
        {
          key: "stdout-.ambient/tool-outputs/stdout.txt",
          label: "stdout",
          charsLabel: "17,000 chars total",
          previewCharsLabel: "12,000 preview",
          bytesLabel: "17,123 bytes",
          artifactPath: ".ambient/tool-outputs/stdout.txt",
          suggestedToolsLabel: "Use file_read or long_context_process for exact text or summarization.",
        },
        {
          key: "stderr-1",
          label: "stderr",
          charsLabel: "7,500 chars",
        },
      ],
    });
  });

  it("builds large-output previews from legacy materialized result notices", () => {
    const parsed = parseToolMessage(
      [
        "browser_content completed",
        "",
        "Result",
        "Title: Long page",
        "",
        "Text:",
        "page preview",
        "",
        "[truncated] page text preview is 12,000 of 24,500 chars, 25,000 bytes.",
        "Full output saved at: .ambient/tool-outputs/page.txt",
        "Use file_read for exact text, or long_context_process for summarization/querying when the output is too large for direct context.",
      ].join("\n"),
      "browser_content",
      "/workspace",
    );

    expect(parsed.resultPreview).toBe("page text · 24,500 chars · 12,000 preview · full output: .ambient/tool-outputs/page.txt");
    expect(parsed.result).toBe(["Title: Long page", "", "Text:", "page preview"].join("\n"));
    expect(parsed.result).not.toContain("[truncated]");
    expect(parsed.result).not.toContain("Full output saved");
    expect(parsed.largeOutputPreview).toMatchObject({
      items: [
        {
          label: "page text",
          chars: 24500,
          previewChars: 12000,
          artifactPath: ".ambient/tool-outputs/page.txt",
          artifactBytes: 25000,
          suggestedTools: ["file_read", "long_context_process"],
        },
      ],
    });
  });

  it("hides notice-only materialized output results after building shared rows", () => {
    const parsed = parseToolMessage(
      [
        "bash completed",
        "",
        "Command",
        "cat huge.log",
        "",
        "Result",
        "[truncated] stdout preview is 16,000 of 17,000 chars, 17,123 bytes.",
        "Full output saved at: .ambient/tool-outputs/stdout.txt",
        "Use file_read for exact text, or long_context_process for summarization/querying when the output is too large for direct context.",
      ].join("\n"),
      "bash",
      "/workspace",
    );

    expect(parsed.result).toBe("");
    expect(parsed.resultPreview).toBe("stdout · 17,000 chars · 16,000 preview · full output: .ambient/tool-outputs/stdout.txt");
    expect(parsed.largeOutputPreview?.items[0]).toMatchObject({
      label: "stdout",
      chars: 17000,
      previewChars: 16000,
      artifactPath: ".ambient/tool-outputs/stdout.txt",
    });
  });

  it("classifies previewable media artifact paths", () => {
    expect(artifactMediaKindFromPath("screenshots/result.PNG")).toBe("image");
    expect(artifactMediaKindFromPath("audio/out.mp3")).toBe("audio");
    expect(artifactMediaKindFromPath("video/demo.webm")).toBe("video");
    expect(artifactMediaKindFromPath("src/app.ts")).toBeUndefined();
  });

  it("describes media preview failures without rewriting generated artifacts", () => {
    expect(mediaPreviewUnavailableMessage("image")).toBe("File is not a valid image.");
    expect(mediaPreviewUnavailableMessage("audio")).toContain("Audio playback");
    expect(mediaPreviewUnavailableMessage("video")).toContain("Video playback");
  });
});

function toolMessage(toolName: string, content: string): ChatMessage {
  return {
    id: `${toolName}-message`,
    threadId: "thread",
    role: "tool",
    content,
    createdAt: "2026-05-01T00:00:00.000Z",
    metadata: { toolName, status: "done" },
  };
}
