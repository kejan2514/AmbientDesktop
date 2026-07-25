#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { liveRunSettledAfterCurrentSend } from "./web-research-live-state.mjs";

const repoRoot = process.cwd();
const resultsDir = join(repoRoot, "test-results", "large-context-blowup");
const artifactCopiesDir = join(resultsDir, "artifacts");
const latestReportPath = join(resultsDir, "latest.json");
const defaultDogfoodProvider = "ambient";
const defaultDogfoodModel = "example/model-id";
const appWaitTimeoutMs = 90_000;
const cdpCommandTimeoutMs = 20_000;
const chatTurnTimeoutMs = Number(process.env.AMBIENT_LARGE_CONTEXT_BLOWUP_CHAT_TIMEOUT_MS ?? 360_000);
const builderPackageName = `dogfood-large-context-${Date.now().toString(36)}`;
const builderSourcePath = `.ambient/capability-builder/packages/${builderPackageName}`;
const generatedPathPrefix = ".venv/lib/python3.12/site-packages/huge_dep";
const pluginLargeOutputLines = 20_000;
const pluginFinalLine = `pluginOutputLine ${String(pluginLargeOutputLines).padStart(4, "0")}`;
const fixturePluginId = ".agents/plugins/marketplace.json:ambient-fixture";
const forbiddenLargeContextToolNames = new Set([
  "bash",
  "shell",
  "file_read",
  "read_file",
  "file_search",
  "directory_list",
  "list_directory",
  "local_file_read",
  "local_directory_list",
  "local_file_search",
  "ls",
  "grep",
  "find",
  "rg",
  "cat",
  "head",
  "tail",
  "read",
  "write",
  "edit",
]);

const report = {
  scenario: "large-context-blowup",
  status: "running",
  startedAt: new Date().toISOString(),
  git: {
    branch: gitValue(["rev-parse", "--abbrev-ref", "HEAD"]),
    commit: gitValue(["rev-parse", "HEAD"]),
  },
  provider: dogfoodProviderId(),
  model: dogfoodModelId(),
  workspacePath: undefined,
  userDataPath: undefined,
  builderSourcePath,
  cases: [],
  checks: {},
  artifacts: {},
};

let exitCode = 0;
let scratch;
let app;
let cdp;
let dogfoodEnv;

try {
  await rm(latestReportPath, { force: true });
  await mkdir(artifactCopiesDir, { recursive: true });
  scratch = await createScratch();
  report.workspacePath = scratch.workspacePath;
  report.userDataPath = scratch.userDataPath;

  await seedWorkspace(scratch.workspacePath);

  dogfoodEnv = buildDogfoodEnv({
    AMBIENT_E2E: "1",
    AMBIENT_DESKTOP_WORKSPACE: scratch.workspacePath,
    AMBIENT_E2E_USER_DATA: scratch.userDataPath,
    AMBIENT_LARGE_CONTEXT_BLOWUP_DOGFOOD: "1",
  });
  await run("pnpm", ["run", "prepare:electron-native"], dogfoodEnv);

  app = launchDesktop(scratch);
  cdp = await connectToElectron(dogfoodCdpPort(), app);
  await cdp.send("Runtime.enable");
  await cdp.send("Page.enable");
  await setViewport(cdp, 1500, 950);
  await waitForText(cdp, "Ambient", appWaitTimeoutMs);
  await installLiveCollector(cdp);
  report.checks.ambientKey = await assertAmbientKey(cdp);
  report.checks.fixturePlugin = await trustFixturePlugin(cdp);

  const threadId = await createThread(cdp, "Large context blowup dogfood");
  report.threadId = threadId;
  report.artifacts.seededWorkspace = await copySeedSummary(scratch.workspacePath);

  const caseA = await runCaseA(cdp, threadId);
  report.cases.push(caseA);
  const caseB = await runCaseB(cdp, threadId);
  report.cases.push(caseB);
  const caseC = await runCaseC(cdp, threadId, caseB.inventoryArtifact?.path);
  report.cases.push(caseC);
  const caseD = await runCaseD(cdp, threadId, scratch.workspacePath);
  report.cases.push(caseD);

  report.artifacts.desktopScreenshot = await writeScreenshot(cdp, "large-context-blowup-final.png");
  report.status = "passed";
} catch (error) {
  exitCode = 1;
  report.status = "failed";
  report.error = error instanceof Error ? error.stack ?? error.message : String(error);
  if (cdp) {
    report.artifacts.failureScreenshot = await writeScreenshot(cdp, "large-context-blowup-failure.png").catch((screenshotError) => ({
      error: screenshotError instanceof Error ? screenshotError.message : String(screenshotError),
    }));
    report.bodyTail = await bodyText(cdp).then((text) => text.slice(-4000)).catch(() => undefined);
    report.liveTail = await getLiveState(cdp).catch(() => undefined);
  }
  process.stderr.write(`${report.error}\n`);
} finally {
  await writeReport(report);
  if (cdp) cdp.close();
  if (app) await terminateProcessTree(app);
  if (dogfoodEnv) {
    try {
      await run("pnpm", ["run", "prepare:node-native"], dogfoodEnv);
    } catch (error) {
      exitCode = 1;
      process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    }
  }
  if (scratch) await cleanupScratch(scratch);
}

process.exit(exitCode);

async function runCaseA(cdpClient, threadId) {
  const turn = await runChatTurn(cdpClient, threadId, [
    "Live large-context blowup dogfood Case A.",
    `Call ambient_capability_builder_list_files exactly once with sourcePath ${JSON.stringify(builderSourcePath)}, maxEntries 80, maxDepth 12, and includeGenerated false.`,
    "Do not use bash, file_read, local file tools, or generic filesystem listing for this case.",
    "After the tool returns, answer in one short sentence containing CASE_A_BUILDER_DEFAULT_OK and state whether generated directories were summarized.",
  ].join("\n"));
  assertNoForbiddenLargeContextTools(turn, "Case A");
  assertNoToolErrors(turn, "Case A");
  const builderMessage = lastToolMessage(turn, "ambient_capability_builder_list_files");
  assertToolMessageCount(turn, "ambient_capability_builder_list_files", 1, "Case A");
  assert(builderMessage, `Case A did not call ambient_capability_builder_list_files. Tools: ${turn.toolNames.join(", ")}`);
  const text = builderMessage.content;
  assert(text.includes("Generated content: omitted by default"), "Case A listing did not report generated content as omitted by default.");
  assert(text.includes("Omitted directory summaries shown"), "Case A listing did not include omitted directory summaries.");
  assert(text.includes("- .venv/ (generated;"), "Case A listing did not summarize the .venv generated directory.");
  assert(!text.includes(`${generatedPathPrefix}/module_a.py`), "Case A Pi-visible listing included raw generated .venv module paths.");
  assert(turn.assistantText.includes("CASE_A_BUILDER_DEFAULT_OK"), `Case A final answer missing marker. Assistant: ${turn.assistantText.slice(-1000)}`);
  const inventoryArtifact = inventoryArtifactFromToolMessage(builderMessage);
  const copiedInventory = await copyWorkspaceArtifact(report.workspacePath, inventoryArtifact?.path, "case-a-inventory.txt");
  return {
    name: "case-a-default-builder-listing",
    status: "passed",
    toolNames: turn.toolNames,
    assistantTail: turn.assistantText.slice(-1000),
    omittedDirectoryCount: builderMessage.metadata?.toolResultDetails?.omittedDirectoryCount,
    inventoryArtifact: inventoryArtifactPathSummary(inventoryArtifact, copiedInventory),
    piVisibleChars: text.length,
  };
}

async function runCaseB(cdpClient, threadId) {
  const turn = await runChatTurn(cdpClient, threadId, [
    "Live large-context blowup dogfood Case B.",
    `Call ambient_capability_builder_list_files with sourcePath ${JSON.stringify(builderSourcePath)}, pathPrefix ${JSON.stringify(generatedPathPrefix)}, includeGenerated true, maxEntries 1, and maxDepth 12.`,
    "Then call ambient_capability_builder_list_files a second time using the returned Structured next page input object. Keep the exact same sourcePath, pathPrefix, includeGenerated, maxEntries, and maxDepth values.",
    "Do not use bash, file_read, local file tools, or generic filesystem listing for this case.",
    "After the second page returns, answer in one short sentence containing CASE_B_BUILDER_SCOPED_OK and mention the two generated filenames.",
  ].join("\n"));
  assertNoForbiddenLargeContextTools(turn, "Case B");
  assertNoToolErrors(turn, "Case B");
  assertToolMessageCount(turn, "ambient_capability_builder_list_files", 2, "Case B");
  const builderMessages = toolMessages(turn, "ambient_capability_builder_list_files");
  assert(builderMessages.length >= 2, `Case B expected at least two Builder list calls. Tools: ${turn.toolNames.join(", ")}`);
  const first = builderMessages[0];
  const second = builderMessages[1];
  assert(first.content.includes(`Path prefix: ${generatedPathPrefix}`), "Case B first page did not preserve the generated pathPrefix.");
  assert(first.content.includes("Generated content: included for this scoped request"), "Case B first page did not include generated content for a scoped request.");
  assert(first.content.includes("Next cursor:"), "Case B first page did not expose a next cursor.");
  assert(second.content.includes(`Path prefix: ${generatedPathPrefix}`), "Case B second page did not preserve the generated pathPrefix.");
  assert(second.content.includes("Generated content: included for this scoped request"), "Case B second page did not preserve includeGenerated.");
  assert(turn.assistantText.includes("CASE_B_BUILDER_SCOPED_OK"), `Case B final answer missing marker. Assistant: ${turn.assistantText.slice(-1000)}`);
  const visibleText = builderMessages.map((message) => message.content).join("\n");
  const listedGeneratedFiles = [...visibleText.matchAll(/- \.venv\/lib\/python3\.12\/site-packages\/huge_dep\/([^ ]+) \(/g)]
    .map((match) => match[1])
    .filter(Boolean);
  assert(new Set(listedGeneratedFiles).size >= 2, `Case B pages did not expose two generated files. Files: ${listedGeneratedFiles.join(", ")}`);
  const inventoryArtifact = inventoryArtifactFromToolMessage(second);
  assert(typeof inventoryArtifact?.path === "string" && inventoryArtifact.path.startsWith(".ambient/tool-outputs/"), "Case B second page did not expose a materialized inventory artifact.");
  return {
    name: "case-b-scoped-generated-pagination",
    status: "passed",
    toolNames: turn.toolNames,
    pageCount: builderMessages.length,
    firstPageHasCursor: first.content.includes("Next cursor:"),
    listedGeneratedFiles,
    pathPrefix: first.metadata?.toolResultDetails?.pathPrefix ?? generatedPathPrefix,
    inventoryArtifact: inventoryArtifactPathSummary(inventoryArtifact),
    assistantTail: turn.assistantText.slice(-1000),
  };
}

async function runCaseC(cdpClient, threadId, expectedInventoryArtifactPath) {
  assert(typeof expectedInventoryArtifactPath === "string" && expectedInventoryArtifactPath.trim(), "Case C missing expected inventory artifact path from Case B.");
  const turn = await runChatTurn(cdpClient, threadId, [
    "Live large-context blowup dogfood Case C.",
    "Use long-context processing against the materialized filtered inventory artifact from the latest scoped ambient_capability_builder_list_files result.",
    `Pass taskType "qa", maxModelCalls 4, and workspacePaths containing exactly this artifact path: ${JSON.stringify(expectedInventoryArtifactPath)}.`,
    "Ask it this targeted question: Which files in huge_dep look related to tokenizers, and what Builder sourcePath did the inventory come from?",
    "Do not paste the inventory into chat and do not use bash or generic filesystem tools.",
    "After long-context processing returns, answer concisely with CASE_C_RLM_HANDOFF_OK, the artifact path you used, and the tokenizer-related filenames.",
  ].join("\n"));
  assertNoForbiddenLargeContextTools(turn, "Case C");
  assertNoToolErrors(turn, "Case C");
  const longContext = longContextCaseCToolUsage(turn);
  assert(longContext, `Case C did not use a recognized long-context tool contract. Tools: ${turn.toolNames.join(", ")}`);
  const rlmInput = normalizedToolInput(longContext.inputMessage, longContext.inputToolName);
  const workspacePaths = arrayOfStrings(rlmInput?.workspacePaths);
  assert(
    workspacePaths.includes(expectedInventoryArtifactPath),
    `Case C long-context processing did not receive the expected workspacePaths artifact. Expected ${expectedInventoryArtifactPath}; input=${JSON.stringify(rlmInput)}`,
  );
  const pastedText = typeof rlmInput?.text === "string" ? rlmInput.text : "";
  assert(!pastedText.includes(generatedPathPrefix), "Case C pasted generated inventory text into long-context processing instead of using workspacePaths.");
  assert(longContext.resultMessage.metadata?.status !== "error", `Case C long-context processing failed: ${longContext.resultMessage.content.slice(0, 1000)}`);
  assert(!/ENOENT|no such file|failed/i.test(longContext.resultMessage.content), `Case C long-context processing did not successfully process the artifact: ${longContext.resultMessage.content.slice(0, 1000)}`);
  const tokenizerEvidence = `${turn.assistantText}\n${longContext.resultMessage.content}`;
  assert(
    tokenizerEvidence.includes("tokenizer_config.json") && tokenizerEvidence.includes("tokenizer.model"),
    `Case C did not verify the tokenizer filenames. Evidence: ${tokenizerEvidence.slice(-1200)}`,
  );
  assert(turn.assistantText.includes("CASE_C_RLM_HANDOFF_OK"), `Case C final answer missing marker. Assistant: ${turn.assistantText.slice(-1000)}`);
  assert(turn.assistantText.includes(".ambient/tool-outputs/"), "Case C final answer did not cite a materialized inventory artifact path.");
  return {
    name: "case-c-rlm-handoff",
    status: "passed",
    toolNames: turn.toolNames,
    assistantTail: turn.assistantText.slice(-1200),
    longContextContract: longContext.contract,
    longContextToolCalls: longContext.toolNames.length,
    inventoryArtifactPath: expectedInventoryArtifactPath,
    longContextWorkspacePaths: workspacePaths,
  };
}

function longContextCaseCToolUsage(turn) {
  const processMessage = lastToolMessage(turn, "long_context_process");
  if (processMessage) {
    assertToolMessageCount(turn, "long_context_process", 1, "Case C");
    return {
      contract: "process",
      inputMessage: processMessage,
      inputToolName: "long_context_process",
      resultMessage: processMessage,
      toolNames: ["long_context_process"],
    };
  }

  const startMessage = lastToolMessage(turn, "long_context_start");
  const asyncMessage = lastToolMessage(turn, "long_context_async");
  const pollMessage = lastToolMessage(turn, "long_context_poll");
  if (!startMessage || (!asyncMessage && !pollMessage)) return undefined;
  assertToolMessageCount(turn, "long_context_start", 1, "Case C");
  const resultMessage = [...toolMessages(turn, "long_context_async"), ...toolMessages(turn, "long_context_poll")]
    .reverse()
    .find(longContextAsyncMessageCompleted);
  if (!resultMessage) return undefined;
  return {
    contract: "async",
    inputMessage: startMessage,
    inputToolName: "long_context_start",
    resultMessage,
    toolNames: ["long_context_start", ...(asyncMessage ? ["long_context_async"] : []), ...(pollMessage ? ["long_context_poll"] : [])],
  };
}

function longContextAsyncMessageCompleted(message) {
  const detailStatus = String(message?.metadata?.toolResultDetails?.status ?? "");
  if (detailStatus === "completed") return true;
  return /\bstatus:\s*completed\b/i.test(String(message?.content ?? ""));
}

async function runCaseD(cdpClient, threadId, workspacePath) {
  const turn = await runChatTurn(cdpClient, threadId, [
    "Live large-context blowup dogfood Case D.",
    `Call the Codex plugin MCP tool named ambient_fixture_markdown_echo with markdown exactly "large context blowup universal cap fixture" and outputLines exactly ${pluginLargeOutputLines}.`,
    "This is a direct plugin MCP tool call; do not route it through ambient_tool_call or ambient_tool_search.",
    "Do not quote the generated output lines in the final answer.",
    "After the tool result returns, answer in one short sentence containing CASE_D_UNIVERSAL_CAP_OK and report outputLines.",
  ].join("\n"));
  assertNoForbiddenLargeContextTools(turn, "Case D");
  assertNoToolErrors(turn, "Case D");
  assertNoRawToolEvents(turn, new Set(["ambient_tool_call", "ambient_tool_search"]), "Case D");
  assertRawToolEventCount(turn, "ambient_fixture_markdown_echo", 1, "Case D");
  assertToolMessageCount(turn, "ambient_fixture_markdown_echo", 1, "Case D");
  const pluginMessage = lastToolMessage(turn, "ambient_fixture_markdown_echo");
  assert(pluginMessage, `Case D did not call ambient_fixture_markdown_echo. Tools: ${turn.toolNames.join(", ")}`);
  const details = pluginMessage.metadata?.toolResultDetails ?? {};
  const largeOutputPreview = details.largeOutputPreview;
  const item = largeOutputPreview?.items?.[0];
  assert(item?.chars > 1_000_000, `Case D output was not megabyte-scale. largeOutputPreview=${JSON.stringify(largeOutputPreview)}`);
  assert(item?.previewChars === 12_000, `Case D preview was not capped at 12000 chars. largeOutputPreview=${JSON.stringify(largeOutputPreview)}`);
  assert(typeof item?.artifactPath === "string" && item.artifactPath.startsWith(".ambient/tool-outputs/"), `Case D missing workspace artifact path. largeOutputPreview=${JSON.stringify(largeOutputPreview)}`);
  assert(pluginMessage.content.length < 40_000, `Case D Pi-visible tool message was unexpectedly large: ${pluginMessage.content.length} chars.`);
  assert(!pluginMessage.content.includes(pluginFinalLine), "Case D Pi-visible preview contained the final generated output line.");
  const artifact = await readFile(join(workspacePath, item.artifactPath), "utf8");
  assert(artifact.includes(pluginFinalLine), `Case D full artifact did not contain ${pluginFinalLine}.`);
  assert(turn.assistantText.includes("CASE_D_UNIVERSAL_CAP_OK"), `Case D final answer missing marker. Assistant: ${turn.assistantText.slice(-1000)}`);
  const copiedArtifact = await copyWorkspaceArtifact(workspacePath, item.artifactPath, "case-d-plugin-large-output.txt");
  return {
    name: "case-d-universal-tool-result-cap",
    status: "passed",
    toolNames: turn.toolNames,
    assistantTail: turn.assistantText.slice(-1000),
    largeOutputPreview: {
      chars: item.chars,
      previewChars: item.previewChars,
      artifactPath: item.artifactPath,
      copiedArtifact,
    },
    piVisibleChars: pluginMessage.content.length,
  };
}

async function seedWorkspace(workspacePath) {
  await mkdir(workspacePath, { recursive: true });
  await writeFile(join(workspacePath, "README.md"), [
    "# Large Context Blowup Dogfood Workspace",
    "",
    "This workspace is seeded by scripts/large-context-blowup-dogfood.mjs.",
    "It contains a Builder-managed package with generated dependency trees and a trusted fixture plugin.",
  ].join("\n"), "utf8");
  await seedBuilderPackage(workspacePath);
  await seedFixtureMarketplace(workspacePath);
}

async function seedBuilderPackage(workspacePath) {
  const packageRoot = join(workspacePath, builderSourcePath);
  await mkdir(join(packageRoot, "scripts"), { recursive: true });
  await mkdir(join(packageRoot, "tests"), { recursive: true });
  await mkdir(join(packageRoot, "docs", "deep", "nested"), { recursive: true });
  await mkdir(join(packageRoot, generatedPathPrefix), { recursive: true });
  await mkdir(join(packageRoot, ".cache", "pip", "wheels"), { recursive: true });
  await writeJson(join(packageRoot, "ambient-cli.json"), {
    name: builderPackageName,
    version: "0.1.0",
    description: "Dogfood fixture for bounded Builder file inventory.",
    skills: "./SKILL.md",
    commands: {
      [builderPackageName.replace(/[^a-z0-9]+/gi, "_").toLowerCase()]: {
        description: "Fixture command.",
        command: "node",
        args: ["./scripts/run.mjs"],
        cwd: "package",
        healthCheck: ["node", "./scripts/run.mjs", "--health"],
      },
    },
    env: [],
    artifacts: {
      outputTypes: [],
      policy: "return concise fixture text only",
    },
  });
  await writeFile(join(packageRoot, "SKILL.md"), [
    "---",
    `name: ${builderPackageName}`,
    "description: Dogfood fixture for bounded Builder file inventory.",
    "---",
    "",
    "Use this fixture only for Ambient large-context blowup dogfood validation.",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "scripts", "run.mjs"), [
    "#!/usr/bin/env node",
    "if (process.argv.includes('--health')) {",
    "  console.log('ok');",
    "} else {",
    "  console.log('large-context fixture command');",
    "}",
  ].join("\n"), "utf8");
  await writeFile(join(packageRoot, "tests", "smoke.test.mjs"), [
    "import { describe, expect, it } from 'vitest';",
    "describe('large context fixture', () => {",
    "  it('has a deterministic source fixture', () => {",
    "    expect('large-context').toContain('context');",
    "  });",
    "});",
  ].join("\n"), "utf8");
  await writeJson(join(packageRoot, "capability-build.json"), {
    schemaVersion: "ambient-capability-builder-v1",
    name: builderPackageName,
    version: "0.1.0",
    goal: "Dogfood bounded Builder file inventory.",
    installerShape: "custom-cli",
    outputArtifactTypes: [],
    responseFormats: [],
    locality: "local",
    createdAt: new Date().toISOString(),
    status: "draft",
    refs: { latest: null, installed: null, lastValidated: null },
  });
  await writeFile(join(packageRoot, "docs", "usage.md"), "Use ambient_capability_builder_list_files for this package.\n", "utf8");
  await writeFile(join(packageRoot, "docs", "deep", "nested", "notes.md"), "# Nested notes\n", "utf8");
  await writeFile(join(packageRoot, generatedPathPrefix, "module_a.py"), "print('module a')\n", "utf8");
  await writeFile(join(packageRoot, generatedPathPrefix, "module_b.py"), "print('module b')\n", "utf8");
  await writeFile(join(packageRoot, generatedPathPrefix, "tokenizer_config.json"), "{\"tokenizer\": true}\n", "utf8");
  await writeFile(join(packageRoot, generatedPathPrefix, "tokenizer.model"), "fixture-tokenizer-model\n", "utf8");
  for (let index = 1; index <= 80; index += 1) {
    await writeFile(
      join(packageRoot, ".cache", "pip", "wheels", `wheel-${String(index).padStart(3, "0")}.txt`),
      `generated wheel fixture ${index}\n`,
      "utf8",
    );
  }
}

async function seedFixtureMarketplace(workspacePath) {
  const pluginRoot = join(workspacePath, "plugins", "ambient-fixture");
  await mkdir(dirname(pluginRoot), { recursive: true });
  await cp(join(repoRoot, "plugins", "ambient-fixture"), pluginRoot, { recursive: true, force: true });
  await writeJson(join(workspacePath, ".agents", "plugins", "marketplace.json"), {
    name: "ambient-large-context-blowup-fixtures",
    interface: { displayName: "Ambient Large Context Blowup Fixtures" },
    plugins: [
      {
        name: "ambient-fixture",
        source: { source: "local", path: "./plugins/ambient-fixture" },
        category: "Productivity",
      },
    ],
  });
}

async function trustFixturePlugin(cdpClient) {
  const result = await evaluate(cdpClient, async (pluginId) => {
    const before = await window.ambientDesktop.discoverCodexPlugins();
    await window.ambientDesktop.setCodexPluginTrusted({ pluginId, trusted: true });
    await window.ambientDesktop.setCodexPluginEnabled({ pluginId, enabled: true });
    const after = await window.ambientDesktop.discoverCodexPlugins();
    const plugin = after.plugins.find((candidate) => candidate.id === pluginId || candidate.name === "ambient-fixture");
    return {
      pluginCountBefore: before.plugins.length,
      pluginCountAfter: after.plugins.length,
      pluginId: plugin?.id,
      trusted: plugin?.trusted,
      enabled: plugin?.enabled,
      toolCount: plugin?.mcp?.tools?.length ?? plugin?.tools?.length,
    };
  }, fixturePluginId);
  assert(result?.trusted === true, `Fixture plugin was not trusted: ${JSON.stringify(result)}`);
  assert(result?.enabled !== false, `Fixture plugin was not enabled: ${JSON.stringify(result)}`);
  return result;
}

async function assertAmbientKey(cdpClient) {
  const configuredKeyFile = ambientApiKeyFilePath();
  const hasEnvKey = Boolean(process.env.AMBIENT_API_KEY?.trim() || process.env.AMBIENT_AGENT_AMBIENT_API_KEY?.trim());
  const hasKeyFile = existsSync(configuredKeyFile);
  const result = await evaluate(cdpClient, async () => {
    if (!window.ambientDesktop.testAmbientApiKey) return { ok: true, skipped: true };
    return window.ambientDesktop.testAmbientApiKey();
  });
  if (!result?.ok && !hasEnvKey && !hasKeyFile) {
    throw new Error(`Ambient API key check failed: ${result?.message ?? "unknown error"}`);
  }
  return {
    rendererSavedKeyOk: result?.ok === true,
    envKeyConfigured: hasEnvKey,
    keyFileConfigured: hasKeyFile,
    keyFilePath: hasKeyFile ? configuredKeyFile : undefined,
  };
}

async function createThread(cdpClient, title) {
  const threadId = await evaluate(cdpClient, async (threadTitle, model) => {
    const state = await window.ambientDesktop.bootstrap();
    const next = await window.ambientDesktop.createThread({
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: model || state.settings.model,
      thinkingLevel: "minimal",
    });
    const id = next.activeThreadId;
    if (window.ambientDesktop.updateThread) {
      await window.ambientDesktop.updateThread({ threadId: id, title: threadTitle });
    }
    await window.ambientDesktop.selectThread(id);
    return id;
  }, title, dogfoodModelId());
  assert(threadId, "createThread did not return an active thread id.");
  return threadId;
}

async function runChatTurn(cdpClient, threadId, content) {
  await resetLiveCollector(cdpClient);
  await evaluate(cdpClient, async (input) => {
    const live = window.__ambientLargeContextDogfood;
    const state = await window.ambientDesktop.bootstrap();
    await window.ambientDesktop.selectThread(input.threadId);
    window.ambientDesktop.sendMessage({
      threadId: input.threadId,
      content: input.content,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: input.model || state.settings.model,
      thinkingLevel: "minimal",
    })
      .then(() => {
        live.sendResolved = true;
      })
      .catch((error) => {
        live.error = error instanceof Error ? error.message : String(error);
      });
    return true;
  }, { threadId, content, model: dogfoodModelId() });
  await waitForLiveCompletion(cdpClient, chatTurnTimeoutMs);
  const state = await evaluate(cdpClient, async (id) => {
    await window.ambientDesktop.selectThread(id);
    return window.ambientDesktop.bootstrap();
  }, threadId);
  const live = await getLiveState(cdpClient);
  const messages = (state.messages ?? []).filter((message) => message.threadId === threadId);
  const turnToolMessages = canonicalToolMessages(live?.toolMessages ?? []);
  const turnToolNames = turnToolMessages.map((message) => message.toolName);
  const assistantText = messages
    .filter((message) => message.role === "assistant" && message.metadata?.kind !== "thinking")
    .map((message) => message.content)
    .join("\n");
  return {
    threadId,
    assistantText,
    toolNames: turnToolNames,
    eventToolNames: live?.toolNames ?? [],
    allToolNames: toolNamesFromMessages(messages, live),
    live,
    toolMessages: turnToolMessages,
    messages,
  };
}

function toolNamesFromMessages(messages, live) {
  const names = new Set(canonicalToolMessages(live?.toolMessages ?? []).map((message) => message.toolName));
  for (const message of messages) {
    if (message.role !== "tool") continue;
    const toolName = canonicalToolName({
      toolName: message.metadata?.toolName,
      metadata: message.metadata,
      content: message.content,
    });
    if (toolName) names.add(toolName);
  }
  return [...names];
}

function canonicalToolMessages(messages) {
  return messages
    .map((message) => ({
      ...message,
      toolName: canonicalToolName(message),
    }))
    .filter((message) => message.toolName);
}

function canonicalToolName(message) {
  const metadata = message?.metadata ?? {};
  const candidates = [
    metadata.toolName,
    metadata.toolArgumentProgress?.toolName,
    metadata.toolResultDetails?.toolName,
    message?.toolName,
  ];
  for (const candidate of candidates) {
    const toolName = String(candidate ?? "");
    if (toolName && toolName !== "ambient_tool_call") return toolName;
  }
  const completedMatch = String(message?.content ?? "").match(/^([a-zA-Z0-9_:-]+) completed\b/);
  if (completedMatch?.[1] && completedMatch[1] !== "ambient_tool_call") return completedMatch[1];
  return String(message?.toolName ?? metadata.toolName ?? "");
}

function toolMessages(turn, toolName) {
  return (turn.toolMessages ?? []).filter((message) => message.toolName === toolName);
}

function lastToolMessage(turn, toolName) {
  return toolMessages(turn, toolName).at(-1);
}

function normalizedToolInput(message, toolName) {
  const rawInput = rawToolInput(message);
  return normalizeToolArgumentsForTool(toolName, rawInput);
}

function rawToolInput(message) {
  const candidates = [
    message?.inputContent,
    transcriptInputContent(message?.content),
    message?.metadata?.inputContent,
    message?.metadata?.rawInput,
    message?.metadata?.toolInput,
    message?.metadata?.input,
    message?.metadata?.arguments,
    message?.metadata?.params,
    message?.metadata?.toolResultDetails?.inputContent,
    message?.metadata?.toolResultDetails?.rawInput,
    message?.metadata?.toolResultDetails?.toolInput,
    message?.metadata?.toolResultDetails?.arguments,
  ];
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === "") continue;
    return parsePossiblyJson(candidate);
  }
  return undefined;
}

function transcriptInputContent(content) {
  if (typeof content !== "string") return undefined;
  const marker = "Input\n";
  const start = content.indexOf(marker);
  if (start < 0) return undefined;
  const section = content.slice(start + marker.length);
  const resultStart = section.search(/\n\nResult\n/);
  return (resultStart >= 0 ? section.slice(0, resultStart) : section).trim();
}

function parsePossiblyJson(value) {
  if (typeof value !== "string") return value;
  try {
    const parsed = JSON.parse(value);
    return parsed === undefined ? value : parsed;
  } catch {
    return value;
  }
}

function normalizeToolArgumentsForTool(toolName, value, depth = 0) {
  if (depth > 5 || !value || typeof value !== "object" || Array.isArray(value)) return value;
  const input = value;
  if (input.toolCall && typeof input.toolCall === "object" && !Array.isArray(input.toolCall)) {
    return normalizeToolArgumentsForTool(toolName, input.toolCall, depth + 1);
  }
  const nestedName = typeof input.toolName === "string" ? input.toolName : typeof input.name === "string" ? input.name : undefined;
  const nestedNameMatches = nestedName?.trim() === toolName;
  const looksLikeToolCallEnvelope = input.type === "toolCall" || input.type === "tool_call";
  if (nestedName && !nestedNameMatches) return value;
  if (nestedNameMatches && ("toolInput" in input || "input" in input)) {
    return normalizeToolArgumentsForTool(toolName, input.toolInput ?? input.input ?? {}, depth + 1);
  }
  if ((nestedNameMatches || looksLikeToolCallEnvelope) && "arguments" in input) {
    return normalizeToolArgumentsForTool(toolName, parsePossiblyJson(input.arguments), depth + 1);
  }
  if (nestedNameMatches && isToolEnvelopeOnly(input)) return {};
  if (!nestedName && isToolEnvelopeOnly(input)) {
    if ("toolInput" in input || "input" in input) {
      return normalizeToolArgumentsForTool(toolName, input.toolInput ?? input.input ?? {}, depth + 1);
    }
    if (looksLikeToolCallEnvelope && "arguments" in input) {
      return normalizeToolArgumentsForTool(toolName, parsePossiblyJson(input.arguments), depth + 1);
    }
  }
  return value;
}

function isToolEnvelopeOnly(input) {
  const envelopeKeys = new Set(["toolCall", "toolName", "name", "toolInput", "input", "arguments", "type"]);
  return Object.keys(input).length > 0 && Object.keys(input).every((key) => envelopeKeys.has(key));
}

function arrayOfStrings(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string") : [];
}

function assertToolMessageCount(turn, toolName, expected, caseName) {
  const actual = toolMessages(turn, toolName).length;
  assert(actual === expected, `${caseName} expected ${expected} ${toolName} call(s), saw ${actual}. Tools: ${turn.toolNames.join(", ")}`);
}

function assertNoForbiddenLargeContextTools(turn, caseName) {
  const checkedNames = [...(turn.toolNames ?? []), ...(turn.eventToolNames ?? [])];
  const forbidden = checkedNames.filter((name) => forbiddenLargeContextToolNames.has(name));
  assert(!forbidden.length, `${caseName} used forbidden large-context tool(s): ${forbidden.join(", ")}`);
}

function assertNoToolErrors(turn, caseName) {
  const failed = (turn.toolMessages ?? []).filter((message) => {
    const status = String(message.metadata?.status ?? "");
    return status === "error" || /\bfailed\b/i.test(String(message.content ?? "").slice(0, 200));
  });
  assert(
    !failed.length,
    `${caseName} had failed tool call(s): ${failed.map((message) => `${message.toolName}:${message.metadata?.status ?? "unknown"}`).join(", ")}`,
  );
}

function assertRawToolEventCount(turn, toolName, expected, caseName) {
  const actual = (turn.eventToolNames ?? []).filter((name) => name === toolName).length;
  assert(actual === expected, `${caseName} expected ${expected} raw ${toolName} event(s), saw ${actual}. Raw tools: ${(turn.eventToolNames ?? []).join(", ")}`);
}

function assertNoRawToolEvents(turn, toolNames, caseName) {
  const forbidden = (turn.eventToolNames ?? []).filter((name) => toolNames.has(name));
  assert(!forbidden.length, `${caseName} used forbidden raw tool event(s): ${forbidden.join(", ")}`);
}

async function installLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    window.__ambientLargeContextDogfood?.unsubscribe?.();
    window.__ambientLargeContextDogfood = {
      statuses: [],
      toolMessageIds: [],
      toolNames: [],
      toolNameCounts: {},
      toolMessages: [],
      runtimeActivities: [],
      assistantTail: "",
      sawRunStart: false,
      sawRunIdle: false,
      lastStatusAtMs: 0,
      sendResolved: true,
      error: undefined,
    };
    const inputContentFromTranscript = (content) => {
      const marker = "Input\n";
      const start = content.indexOf(marker);
      if (start < 0) return undefined;
      const section = content.slice(start + marker.length);
      const resultStart = section.search(/\n\nResult\n/);
      return (resultStart >= 0 ? section.slice(0, resultStart) : section).trim();
    };
    window.__ambientLargeContextDogfood.unsubscribe = window.ambientDesktop.onEvent((event) => {
      const live = window.__ambientLargeContextDogfood;
      if (event.type === "run-status") {
        live.lastStatusAtMs = Date.now();
        live.statuses.push(event.status);
        if (event.status !== "idle") live.sawRunStart = true;
        if (live.sawRunStart && event.status === "idle") live.sawRunIdle = true;
      }
      if (event.type === "runtime-activity") {
        live.runtimeActivities.push({
          kind: event.activity?.kind,
          status: event.activity?.status,
          toolName: event.activity?.toolName ?? event.activity?.details?.toolName,
          message: event.activity?.message,
          outputChars: event.activity?.outputChars,
          thinkingChars: event.activity?.thinkingChars,
        });
        live.runtimeActivities = live.runtimeActivities.slice(-40);
      }
      if (event.type === "message-delta") {
        live.assistantTail = (live.assistantTail + String(event.delta ?? "")).slice(-8000);
      }
      if ((event.type === "message-created" || event.type === "message-updated") && event.message?.role === "tool") {
        const toolName = String(event.message.metadata?.toolName ?? "");
        if (!toolName) return;
        const messageId = event.message.id === undefined || event.message.id === null ? "" : String(event.message.id);
        const toolMessageKey = messageId || `${toolName}:${live.toolNames.length}`;
        const existingIndex = live.toolMessageIds.indexOf(toolMessageKey);
        const previousEntry = existingIndex >= 0 ? live.toolMessages[existingIndex] : undefined;
        const content = String(event.message.content ?? "");
        const entry = {
          id: messageId,
          toolName,
          metadata: event.message.metadata ?? {},
          content,
          inputContent: inputContentFromTranscript(content) ?? previousEntry?.inputContent,
        };
        if (existingIndex >= 0) {
          live.toolMessages[existingIndex] = entry;
        } else {
          live.toolMessageIds.push(toolMessageKey);
          live.toolNames.push(toolName);
          live.toolNameCounts[toolName] = (live.toolNameCounts[toolName] ?? 0) + 1;
          live.toolMessages.push(entry);
        }
        live.toolMessages = live.toolMessages.slice(-30);
      }
      if (event.type === "error") live.error = event.message;
    });
    return true;
  });
}

async function resetLiveCollector(cdpClient) {
  await evaluate(cdpClient, () => {
    const live = window.__ambientLargeContextDogfood;
    if (!live) return false;
    live.statuses = [];
    live.toolMessageIds = [];
    live.toolNames = [];
    live.toolNameCounts = {};
    live.toolMessages = [];
    live.runtimeActivities = [];
    live.assistantTail = "";
    live.sawRunStart = false;
    live.sawRunIdle = false;
    live.lastStatusAtMs = 0;
    live.sendResolved = false;
    live.error = undefined;
    return true;
  });
}

async function waitForLiveCompletion(cdpClient, maxMs) {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    const live = await getLiveState(cdpClient);
    if (live?.error) throw new Error(live.error);
    if (liveRunSettledAfterCurrentSend(live, { idleGraceMs: 2_000 })) return;
    await delay(1_000);
  }
  const live = await getLiveState(cdpClient);
  throw new Error(`Timed out waiting for large-context dogfood chat turn. collector=${JSON.stringify(live)}`);
}

async function getLiveState(cdpClient) {
  return evaluate(cdpClient, () => {
    const live = window.__ambientLargeContextDogfood;
    return live ? {
      statuses: live.statuses,
      toolNames: live.toolNames,
      toolNameCounts: live.toolNameCounts,
      toolMessages: live.toolMessages,
      toolMessageCount: live.toolNames.length,
      runtimeActivities: live.runtimeActivities,
      assistantTail: live.assistantTail,
      sawRunStart: live.sawRunStart,
      sawRunIdle: live.sawRunIdle,
      lastStatusAtMs: live.lastStatusAtMs,
      sendResolved: live.sendResolved,
      error: live.error,
    } : undefined;
  });
}

function launchDesktop(input) {
  return spawn("pnpm", [
    "exec",
    "electron-vite",
    "dev",
    "--",
    `--remote-debugging-port=${dogfoodCdpPort()}`,
  ], {
    cwd: repoRoot,
    stdio: ["ignore", "pipe", "pipe"],
    detached: process.platform !== "win32",
    env: dogfoodEnv ?? buildDogfoodEnv({
      AMBIENT_E2E: "1",
      AMBIENT_DESKTOP_WORKSPACE: input.workspacePath,
      AMBIENT_E2E_USER_DATA: input.userDataPath,
      AMBIENT_LARGE_CONTEXT_BLOWUP_DOGFOOD: "1",
    }),
  });
}

async function connectToElectron(port, child) {
  const started = Date.now();
  let lastOutput = "";
  child.stdout?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  child.stderr?.on("data", (chunk) => {
    lastOutput = `${lastOutput}${chunk.toString()}`.slice(-8000);
  });
  while (Date.now() - started < 60_000) {
    if (child.exitCode !== null) {
      throw new Error(`Electron exited before CDP was available.\n${lastOutput}`);
    }
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl);
        if (page?.webSocketDebuggerUrl) return createCdpClient(page.webSocketDebuggerUrl);
      }
    } catch {
      // Keep polling until Electron exposes the debugger endpoint.
    }
    await delay(250);
  }
  throw new Error(`Timed out waiting for Electron CDP on port ${port}.\n${lastOutput}`);
}

function createCdpClient(url) {
  const socket = new WebSocket(url);
  let nextId = 1;
  const pending = new Map();
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== "number") return;
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message || "CDP command failed"));
    else waiter.resolve(message.result);
  });
  socket.addEventListener("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("CDP socket closed"));
    pending.clear();
  });
  return {
    send(method, params = {}, options = {}) {
      const id = nextId++;
      const timeoutMs = options.timeoutMs ?? cdpCommandTimeoutMs;
      const ready = socket.readyState === WebSocket.OPEN
        ? Promise.resolve()
        : new Promise((resolveReady, rejectReady) => {
          const timeout = setTimeout(() => {
            rejectReady(new Error(`Timed out waiting for CDP socket open after ${timeoutMs}ms.`));
          }, timeoutMs);
          socket.addEventListener("open", () => {
            clearTimeout(timeout);
            resolveReady();
          }, { once: true });
          socket.addEventListener("error", () => {
            clearTimeout(timeout);
            rejectReady(new Error("CDP socket failed to open."));
          }, { once: true });
        });
      return ready.then(() => new Promise((resolveSend, rejectSend) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          rejectSend(new Error(`Timed out waiting for CDP ${method} after ${timeoutMs}ms.`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (value) => {
            clearTimeout(timeout);
            resolveSend(value);
          },
          reject: (error) => {
            clearTimeout(timeout);
            rejectSend(error);
          },
        });
        socket.send(JSON.stringify({ id, method, params }));
      }));
    },
    close() {
      socket.close();
    },
  };
}

async function waitForText(cdpClient, text, timeoutMs) {
  await waitFor(cdpClient, (expected) => document.body.innerText.includes(expected), timeoutMs, text);
}

async function waitFor(cdpClient, predicate, timeoutMs, ...args) {
  const started = Date.now();
  let lastError;
  while (Date.now() - started < timeoutMs) {
    try {
      if (await evaluate(cdpClient, predicate, ...args)) return;
    } catch (error) {
      lastError = error;
    }
    await delay(150);
  }
  const body = await bodyText(cdpClient).catch(() => "");
  throw new Error(`Timed out waiting for Electron UI condition.${lastError ? ` Last error: ${lastError.message}` : ""}\n\nBody tail:\n${body.slice(-2000)}`);
}

async function evaluate(cdpClient, fnOrExpression, ...args) {
  const expression = typeof fnOrExpression === "function"
    ? `(${fnOrExpression.toString()})(...${JSON.stringify(args)})`
    : String(fnOrExpression);
  const result = await cdpClient.send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (result.exceptionDetails) throw new Error(`Runtime.evaluate failed: ${JSON.stringify(result.exceptionDetails)}`);
  return result.result?.value;
}

async function bodyText(cdpClient) {
  return evaluate(cdpClient, () => document.body.innerText);
}

async function setViewport(cdpClient, width, height) {
  await cdpClient.send("Emulation.setDeviceMetricsOverride", {
    width,
    height,
    deviceScaleFactor: 1,
    mobile: false,
  });
}

async function writeScreenshot(cdpClient, name) {
  await mkdir(resultsDir, { recursive: true });
  const result = await cdpClient.send("Page.captureScreenshot", { format: "png", fromSurface: true }, { timeoutMs: 30_000 });
  const outputPath = join(resultsDir, name);
  await writeFile(outputPath, Buffer.from(result.data, "base64"));
  return outputPathRelative(outputPath);
}

async function createScratch() {
  const root = await mkdtemp(join(tmpdir(), "ambient-large-context-blowup-"));
  const workspacePath = resolve(join(root, "workspace"));
  const userDataPath = resolve(join(root, "userData"));
  await mkdir(workspacePath, { recursive: true });
  await mkdir(userDataPath, { recursive: true });
  return {
    root,
    workspacePath,
    userDataPath,
    ownsWorkspace: true,
    ownsUserData: true,
  };
}

async function cleanupScratch(input) {
  if (process.env.AMBIENT_LARGE_CONTEXT_BLOWUP_KEEP_SCRATCH === "1") {
    process.stdout.write(`Large context blowup dogfood scratch retained at ${input.root}\n`);
    return;
  }
  await rm(input.root, { recursive: true, force: true });
}

async function copyWorkspaceArtifact(workspacePath, artifactPath, name) {
  if (typeof artifactPath !== "string" || !artifactPath.trim()) return undefined;
  const source = join(workspacePath, artifactPath);
  if (!existsSync(source)) return undefined;
  const destination = join(artifactCopiesDir, name);
  await cp(source, destination, { force: true });
  return outputPathRelative(destination);
}

async function copySeedSummary(workspacePath) {
  const summaryPath = join(artifactCopiesDir, "seed-summary.json");
  await writeJson(summaryPath, {
    workspacePath,
    builderPackageName,
    builderSourcePath,
    generatedPathPrefix,
    fixturePluginId,
  });
  return outputPathRelative(summaryPath);
}

function inventoryArtifactPathSummary(inventoryArtifact, copiedPath) {
  if (!inventoryArtifact) return undefined;
  return {
    path: inventoryArtifact.path,
    chars: inventoryArtifact.chars,
    previewChars: inventoryArtifact.previewChars,
    inventoryFileCount: inventoryArtifact.inventoryFileCount,
    inventoryFileCountTruncated: inventoryArtifact.inventoryFileCountTruncated,
    copiedPath,
  };
}

function inventoryArtifactFromToolMessage(message) {
  const details = message?.metadata?.toolResultDetails;
  if (typeof details?.inventoryArtifact?.path === "string") return details.inventoryArtifact;
  const item = details?.largeOutputPreview?.items?.find((candidate) => (
    typeof candidate?.artifactPath === "string" &&
    candidate.artifactPath.startsWith(".ambient/tool-outputs/") &&
    candidate.artifactPath.includes("filtered-inventory")
  ));
  if (!item) return undefined;
  return {
    path: item.artifactPath,
    chars: item.chars,
    previewChars: item.previewChars,
    bytes: item.artifactBytes,
    inventoryFileCount: item.inventoryFileCount,
    inventoryFileCountTruncated: item.inventoryFileCountTruncated,
  };
}

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeReport(value) {
  await mkdir(resultsDir, { recursive: true });
  const next = {
    ...value,
    finishedAt: new Date().toISOString(),
    durationMs: Date.now() - Date.parse(value.startedAt),
  };
  await writeFile(latestReportPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  const runReportPath = join(resultsDir, `run-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(runReportPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
}

async function run(command, args, env) {
  const child = spawn(command, args, {
    cwd: repoRoot,
    stdio: "inherit",
    env,
  });
  const [code, signal] = await once(child, "exit");
  if (code !== 0) throw new Error(`${command} ${args.join(" ")} failed with ${signal ?? code}.`);
}

async function terminateProcessTree(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGTERM");
    } else {
      child.kill("SIGTERM");
    }
  } catch {
    // Best effort cleanup.
  }
  if (await waitForAppExit(child, 5_000)) return;
  try {
    if (process.platform !== "win32" && child.pid) {
      process.kill(-child.pid, "SIGKILL");
    } else {
      child.kill("SIGKILL");
    }
  } catch {
    // Best effort cleanup.
  }
}

async function waitForAppExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  const timeout = delay(timeoutMs).then(() => false);
  const exited = new Promise((resolveExit) => child.once("exit", () => resolveExit(true)));
  return Promise.race([timeout, exited]);
}

function buildDogfoodEnv(extra = {}) {
  const providerId = dogfoodProviderId();
  const modelId = dogfoodModelId(providerId);
  const apiKeyFile = ambientApiKeyFilePath();
  return cleanChildEnv({
    ...process.env,
    ...extra,
    AMBIENT_PROVIDER: providerId,
    AMBIENT_API_KEY_FILE: apiKeyFile,
    AMBIENT_AGENT_AMBIENT_API_KEY_FILE: process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE || apiKeyFile,
    ...(providerId === "gmi-cloud" ? { GMI_CLOUD_MODEL: modelId } : { AMBIENT_LIVE_MODEL: modelId }),
  });
}

function ambientApiKeyFilePath() {
  if (process.env.AMBIENT_API_KEY_FILE) return process.env.AMBIENT_API_KEY_FILE;
  let current = repoRoot;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(current, "ignored-provider-key-file.txt");
    if (existsSync(candidate)) return candidate;
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return join(repoRoot, "ignored-provider-key-file.txt");
}

function dogfoodProviderId() {
  return process.env.AMBIENT_PROVIDER || defaultDogfoodProvider;
}

function dogfoodModelId(providerId = dogfoodProviderId()) {
  return providerId === "gmi-cloud"
    ? process.env.GMI_CLOUD_MODEL || process.env.AMBIENT_MODEL || defaultDogfoodModel
    : process.env.AMBIENT_LIVE_MODEL || process.env.AMBIENT_MODEL || defaultDogfoodModel;
}

function cleanChildEnv(env) {
  const next = { ...env };
  delete next.NODE_OPTIONS;
  delete next.VITEST;
  return next;
}

function dogfoodCdpPort() {
  const parsed = Number(process.env.AMBIENT_HARNESS_CDP_PORT || process.env.AMBIENT_SUBAGENT_DESKTOP_DOGFOOD_CDP_PORT);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 19789;
}

function outputPathRelative(path) {
  const rel = relative(repoRoot, path);
  return rel && !rel.startsWith("..") ? rel : path;
}

function gitValue(args) {
  const result = spawnSync("git", args, {
    cwd: repoRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  return result.status === 0 ? result.stdout.trim() : "";
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}
