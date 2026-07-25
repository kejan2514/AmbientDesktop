import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { safeStorage } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AMBIENT_DEFAULT_MODEL } from "../../shared/ambientModels";
import type { PermissionRequest } from "../../shared/permissionTypes";
import type { AmbientPluginAuthAccountSummary, FirstPartyGoogleIntegrationState, GoogleWorkspaceCallInput, GoogleWorkspaceCallResult, GoogleWorkspaceCliInstallState, GoogleWorkspaceDescribeMethodInput, GoogleWorkspaceMaterializeFileInput, GoogleWorkspaceMaterializeFileResult, GoogleWorkspaceMethodSummary, GoogleWorkspaceOAuthClientImportInput, GoogleWorkspaceSearchMethodsInput, GoogleWorkspaceSearchMethodsResult, GoogleWorkspaceSetupInput, GoogleWorkspaceSetupState, GoogleWorkspaceValidationInput, GoogleWorkspaceValidationResult } from "../../shared/pluginTypes";
import type { AgentRuntime, AgentRuntimeGoogleWorkspaceTools } from "./googleWorkspaceAgentRuntimeDogfoodFacade";
import type { BrowserCredentialStore, BrowserService } from "../browser/browserAgentRuntimeContract";
import { GoogleWorkspaceCliAdapter } from "./googleWorkspaceCliAdapter";
import { resolveGoogleWorkspaceLiveDogfoodRuntime } from "./googleWorkspaceLiveDogfood";
import { GOOGLE_WORKSPACE_METHOD_CATALOG, GoogleWorkspaceMethodBroker, searchGoogleWorkspaceMethods } from "./googleWorkspaceMethodBroker";
import type { ProjectStore } from "./googleWorkspaceProjectStoreFacade";

const electronMock = vi.hoisted(() => ({
  userDataPath: `${process.env.TMPDIR || "/tmp"}/ambient-google-setup-dogfood-electron`,
}));

vi.mock("electron", () => ({
  app: {
    getPath: () => electronMock.userDataPath,
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  },
}));

const describeNative = process.env.AMBIENT_TEST_NATIVE === "1" ? describe : describe.skip;
const itLive = process.env.AMBIENT_GOOGLE_SETUP_CHAT_LIVE === "1" ? it : it.skip;
const itRealGoogle = process.env.AMBIENT_GOOGLE_REAL_DOGFOOD === "1" ? it : it.skip;
const itRealGoogleLastMeeting = process.env.AMBIENT_GOOGLE_LAST_MEETING_DOGFOOD === "1" ? it : it.skip;
const itRealGoogleRlm = process.env.AMBIENT_GOOGLE_RLM_DOGFOOD === "1" ? it : it.skip;
const itRealGoogleGmailLabels = process.env.AMBIENT_GOOGLE_GMAIL_LABELS_DOGFOOD === "1" ? it : it.skip;
const itRealGoogleDrivePoetry = process.env.AMBIENT_GOOGLE_DRIVE_POETRY_DOGFOOD === "1" ? it : it.skip;
const itRealGoogleWritePath = process.env.AMBIENT_GOOGLE_WRITE_DOGFOOD === "1" ? it : it.skip;

describeNative("Google Workspace setup live Pi dogfood", () => {
  let workspacePath = "";
  let store: ProjectStore;
  let runtime: AgentRuntime | undefined;
  let google: GoogleWorkspaceDogfoodStub;
  let permissionRequests: Array<Omit<PermissionRequest, "id">> = [];

  beforeEach(async () => {
    ensureAmbientApiKeyEnv();
    workspacePath = await realpath(await mkdtemp(join(tmpdir(), "ambient-google-setup-dogfood-")));
    electronMock.userDataPath = join(workspacePath, ".electron");
    await mkdir(electronMock.userDataPath, { recursive: true });

    const modules = await loadRuntimeModules();
    store = new modules.ProjectStore();
    store.openWorkspace(workspacePath);
    google = createGoogleWorkspaceDogfoodStub();
    permissionRequests = [];
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      { googleWorkspace: google.tools },
    );
  });

  afterEach(async () => {
    await runtime?.shutdownPluginMcpServers();
    runtime = undefined;
    store?.close();
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  itLive("uses the Google Workspace setup status tool instead of improvising", async () => {
    const thread = store.createThread("Google setup status dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google setup dogfood test.",
        "Call google_workspace_status exactly once to inspect Google setup status.",
        "Do not use google_workspace_search_methods, google_workspace_call, shell, bash, browser, filesystem, or plugin install tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_SETUP_STATUS_OK and the validated account email.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_status");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.readIntegration).toBeGreaterThanOrEqual(1);
    expect(permissionRequests).toEqual([]);
    expect(transcript).toContain("GOOGLE_SETUP_STATUS_OK");
    expect(transcript).toContain("travis@example.test");
  }, 240_000);

  itLive("uses the dynamic Google Workspace method broker for a concrete call", async () => {
    const thread = store.createThread("Google dynamic method dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google dynamic method broker dogfood test.",
        "First use google_workspace_search_methods with query exactly gmail labels.",
        "Then use google_workspace_call with methodId exactly gmail.users.labels.list, accountHint exactly travis@example.test, and params {\"userId\":\"me\"}.",
        "Do not use shell, bash, browser, filesystem, or plugin install tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_DYNAMIC_CALL_OK and INBOX.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.searchMethods).toEqual([expect.objectContaining({ query: "gmail labels" })]);
    expect(google.calls.call).toEqual([
      expect.objectContaining({
        accountHint: "travis@example.test",
        methodId: "gmail.users.labels.list",
        params: { userId: "me" },
      }),
    ]);
    expect(permissionRequests).toEqual([]);
    expect(transcript).toContain("GOOGLE_DYNAMIC_CALL_OK");
    expect(transcript).toContain("INBOX");
  }, 240_000);

  itLive("materializes Gmail attachment handles instead of asking for raw attachment bytes", async () => {
    const thread = store.createThread("Google Gmail attachment handle dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google Gmail attachment handle dogfood test.",
        "Use google_workspace_call with methodId exactly gmail.users.messages.attachments.get, accountHint exactly travis@example.test, and params {\"userId\":\"me\",\"messageId\":\"message-1\",\"id\":\"attachment-1\"}.",
        "The result should contain a managed file handle. Save that handle into the current workspace at attachments/google-attachment-dogfood.bin using google_workspace_materialize_file.",
        "Do not use shell, bash, browser, filesystem, plugin install, read, write, or edit tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_GMAIL_ATTACHMENT_HANDLE_OK and attachments/google-attachment-dogfood.bin.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_call");
    expect(tools).toContain("google_workspace_materialize_file");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.call).toEqual([
      expect.objectContaining({
        accountHint: "travis@example.test",
        methodId: "gmail.users.messages.attachments.get",
        params: { userId: "me", messageId: "message-1", id: "attachment-1" },
      }),
    ]);
    expect(google.calls.materializeFile).toEqual([
      expect.objectContaining({
        handle: "gmail-attachment-handle",
        path: "attachments/google-attachment-dogfood.bin",
      }),
    ]);
    expect(transcript).toContain("GOOGLE_GMAIL_ATTACHMENT_HANDLE_OK");
    expect(transcript).toContain("attachments/google-attachment-dogfood.bin");
  }, 240_000);

  itLive("uploads Drive content from a workspace-relative file path", async () => {
    await mkdir(join(workspacePath, "uploads"), { recursive: true });
    await writeFile(join(workspacePath, "uploads", "google-upload-dogfood.txt"), "Google upload dogfood fixture\n", "utf8");
    const thread = store.createThread("Google Drive upload handle dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google Drive upload dogfood test.",
        "Use google_workspace_call with methodId exactly drive.files.create, accountHint exactly travis@example.test, params {\"fields\":\"id,name,mimeType\"}, body {\"name\":\"google-upload-dogfood.txt\",\"mimeType\":\"text/plain\"}, and upload {\"path\":\"uploads/google-upload-dogfood.txt\",\"mimeType\":\"text/plain\"}.",
        "Do not use shell, bash, browser, filesystem, plugin install, read, write, edit, or google_workspace_materialize_file tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_DRIVE_UPLOAD_HANDLE_OK and drive-file-upload-1.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_call");
    expect(tools).not.toContain("google_workspace_materialize_file");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.call).toEqual([
      expect.objectContaining({
        accountHint: "travis@example.test",
        methodId: "drive.files.create",
        params: { fields: "id,name,mimeType" },
        body: { name: "google-upload-dogfood.txt", mimeType: "text/plain" },
        upload: { path: "uploads/google-upload-dogfood.txt", mimeType: "text/plain" },
      }),
    ]);
    expect((google.calls.call[0] as GoogleWorkspaceCallInput & { workspacePath?: string }).workspacePath).toBe(workspacePath);
    expect(transcript).toContain("GOOGLE_DRIVE_UPLOAD_HANDLE_OK");
    expect(transcript).toContain("drive-file-upload-1");
  }, 240_000);

  itLive("creates a Gmail draft attachment from a workspace-relative file path", async () => {
    await mkdir(join(workspacePath, "attachments"), { recursive: true });
    await writeFile(join(workspacePath, "attachments", "gmail-draft-dogfood.txt"), "Gmail draft attachment dogfood fixture\n", "utf8");
    const thread = store.createThread("Google Gmail draft attachment dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google Gmail draft attachment dogfood test.",
        "Use google_workspace_call with methodId exactly gmail.users.drafts.create, accountHint exactly travis@example.test, params {\"userId\":\"me\"}, and gmailDraft {\"to\":\"nobody@example.test\",\"subject\":\"Ambient Gmail attachment dogfood\",\"textBody\":\"This draft is never sent.\",\"attachments\":[{\"path\":\"attachments/gmail-draft-dogfood.txt\",\"mimeType\":\"text/plain\"}]}.",
        "Do not use shell, bash, browser, filesystem, plugin install, read, write, edit, google_workspace_materialize_file, raw MIME, or base64 tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_GMAIL_DRAFT_ATTACHMENT_OK and gmail-draft-attachment-1.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_call");
    expect(tools).not.toContain("google_workspace_materialize_file");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.call).toEqual([
      expect.objectContaining({
        accountHint: "travis@example.test",
        methodId: "gmail.users.drafts.create",
        params: { userId: "me" },
        gmailDraft: {
          to: "nobody@example.test",
          subject: "Ambient Gmail attachment dogfood",
          textBody: "This draft is never sent.",
          attachments: [{ path: "attachments/gmail-draft-dogfood.txt", mimeType: "text/plain" }],
        },
      }),
    ]);
    expect((google.calls.call[0] as GoogleWorkspaceCallInput & { workspacePath?: string }).workspacePath).toBe(workspacePath);
    expect(transcript).toContain("GOOGLE_GMAIL_DRAFT_ATTACHMENT_OK");
    expect(transcript).toContain("gmail-draft-attachment-1");
  }, 240_000);

  itLive("validates a known account through the approved Google setup tool", async () => {
    const thread = store.createThread("Google setup validate dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google validation dogfood test.",
        "Use the first-party Google Workspace account validation tool with accountHint set exactly to travis@example.test.",
        "Do not use google_workspace_search_methods, google_workspace_call, shell, bash, browser, filesystem, or plugin install tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_VALIDATE_OK and the account email.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_validate_account");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.validate).toEqual([expect.objectContaining({ accountHint: "travis@example.test" })]);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        toolName: "google_workspace_validate_account",
        risk: "plugin-tool",
      }),
    ]);
    expect(store.listPermissionAudit(20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: thread.id,
          toolName: "google_workspace_validate_account",
          risk: "plugin-tool",
          decision: "allowed",
        }),
      ]),
    );
    expect(transcript).toContain("GOOGLE_VALIDATE_OK");
    expect(transcript).toContain("travis@example.test");
  }, 240_000);

  itLive("starts login through the approved setup tool without leaking OAuth details", async () => {
    const thread = store.createThread("Google setup login dogfood");

    await runtime!.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google login dogfood test.",
        "Use the first-party Google Workspace login/setup tool with accountHint set exactly to travis@example.test.",
        "Do not use google_workspace_search_methods, google_workspace_call, shell, bash, browser, filesystem, or plugin install tools.",
        "After the tool result is available, answer with one short sentence containing GOOGLE_LOGIN_STARTED_OK and the account handle.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_start_login");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(google.calls.startSetup).toEqual([
      expect.objectContaining({ accountHint: "travis@example.test", command: "login", openAuthUrl: true }),
    ]);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        toolName: "google_workspace_start_login",
        risk: "browser-network",
      }),
    ]);
    expect(store.listPermissionAudit(20)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          threadId: thread.id,
          toolName: "google_workspace_start_login",
          risk: "browser-network",
          decision: "allowed",
        }),
      ]),
    );
    expect(transcript).toContain("GOOGLE_LOGIN_STARTED_OK");
    expect(transcript).toContain("travis@example.test");
    expect(transcript).not.toContain("SHOULD_NOT_LEAK_AUTH_URL");
    expect(transcript).not.toContain("SHOULD_NOT_LEAK_OUTPUT_TAIL");
  }, 240_000);
});

describeNative("Google Workspace real gws dynamic broker dogfood", () => {
  let workspacePath = "";
  let store: ProjectStore;
  let runtime: AgentRuntime | undefined;
  let permissionRequests: Array<Omit<PermissionRequest, "id">> = [];

  beforeEach(async () => {
    ensureAmbientApiKeyEnv();
    workspacePath = await realpath(await mkdtemp(join(tmpdir(), "ambient-google-real-dogfood-")));
    electronMock.userDataPath = join(workspacePath, ".electron");
    await mkdir(electronMock.userDataPath, { recursive: true });

    const modules = await loadRuntimeModules();
    store = new modules.ProjectStore();
    store.openWorkspace(workspacePath);
    permissionRequests = [];
  });

  afterEach(async () => {
    await runtime?.shutdownPluginMcpServers();
    runtime = undefined;
    store?.close();
    if (workspacePath) await rm(workspacePath, { recursive: true, force: true });
  });

  itRealGoogle("discovers a generated method, performs a real safe read, and previews a dry-run write", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const status = adapter.status(accountHint);
    expect(status.state).not.toBe("missing");

    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      { googleWorkspace: realGoogleWorkspaceTools({ accountHint, adapter, broker }) },
    );

    const thread = store.createThread("Google real dynamic broker dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is a live Ambient Desktop dogfood against a real local Google Workspace CLI account.",
        "Use google_workspace_search_methods to find the Calendar colors metadata-read method. Do not assume the method id before searching.",
        `Then call google_workspace_call with the selected colors method, accountHint exactly ${accountHint}, and empty params.`,
        "Next use google_workspace_search_methods to find the Calendar event creation method with service calendar and httpMethod POST.",
        `Then call google_workspace_call with methodId exactly calendar.events.insert, accountHint exactly ${accountHint}, dryRun true, params {"calendarId":"primary"}, and body {"summary":"Ambient dynamic broker dry run","start":{"dateTime":"2026-05-05T12:00:00-07:00"},"end":{"dateTime":"2026-05-05T12:15:00-07:00"}}.`,
        "Do not use shell, bash, browser, filesystem, plugin install, or non-Google tools.",
        "After both Google calls finish, answer with one short sentence containing GOOGLE_REAL_DYNAMIC_DOGFOOD_OK, calendar.colors.get, calendar.events.insert, and DRY_RUN.",
      ].join("\n"),
    });

    const transcript = threadTranscript(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(permissionRequests).toEqual([
      expect.objectContaining({
        toolName: "google_workspace_call",
        risk: "plugin-tool",
        title: expect.stringContaining("data mutation"),
        detail: expect.stringMatching(/Dry run requested: yes[\s\S]*Body: \{summary, start, end\}/),
      }),
    ]);
    expect(transcript).toContain("GOOGLE_REAL_DYNAMIC_DOGFOOD_OK");
    expect(transcript).toContain("calendar.colors.get");
    expect(transcript).toContain("calendar.events.insert");
    expect(transcript).toContain("DRY_RUN");
  }, 300_000);

  itRealGoogleWritePath("creates and cleans up low-risk Calendar, Drive, and Gmail draft mutations through Pi", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const baseGoogleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const marker = `ambient-write-dogfood-${randomUUID()}`;
    const draftRaw = base64Url(
      [
        `To: ${accountHint.includes("@") ? accountHint : "ambient-write-dogfood@example.invalid"}`,
        `Subject: ${marker} draft`,
        "",
        `Temporary Ambient Desktop write-path dogfood draft ${marker}.`,
      ].join("\r\n"),
    );
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const created: GoogleWriteDogfoodCreatedIds = {};
    const cleanupErrors: string[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...baseGoogleTools,
          call: async (call) => {
            googleCalls.push(call);
            return callTrackedGoogleWriteDogfoodMethod(broker, accountHint, call, created);
          },
        },
      },
    );

    const thread = store.createThread("Google real write-path cleanup dogfood");
    let sendError: unknown;
    try {
      await runtime.send({
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [
          "This is a live Ambient Desktop write-path dogfood using my real Google Workspace account.",
          "Use only google_workspace_search_methods and google_workspace_call. Do not use shell, bash, browser, filesystem, plugin install, read, write, or edit tools.",
          `Use accountHint exactly ${accountHint}. Use marker exactly ${marker}.`,
          "First search for and call calendar.events.insert with params {\"calendarId\":\"primary\"}, idempotencyKey marker-calendar-insert, and body with summary marker + \" calendar cleanup test\", start.dateTime \"2030-01-02T12:00:00-07:00\", end.dateTime \"2030-01-02T12:05:00-07:00\".",
          "Read the inserted Calendar event id from the result. Then call calendar.events.delete with params {\"calendarId\":\"primary\",\"eventId\":\"<inserted event id>\"} and idempotencyKey marker-calendar-delete.",
          "Next search for and call drive.files.create with idempotencyKey marker-drive-create and body {\"name\": marker + \" drive cleanup folder\", \"mimeType\":\"application/vnd.google-apps.folder\"}.",
          "Read the created Drive file id from the result. Then call drive.files.delete with params {\"fileId\":\"<created file id>\"} and idempotencyKey marker-drive-delete.",
          `Next search for and call gmail.users.drafts.create with params {"userId":"me"}, idempotencyKey marker-gmail-draft-create, and body {"message":{"raw":"${draftRaw}"}}.`,
          "Read the created Gmail draft id from the result. Then call gmail.users.drafts.delete with params {\"userId\":\"me\",\"id\":\"<created draft id>\"} and idempotencyKey marker-gmail-draft-delete.",
          "After all three cleanup deletes succeed, answer with one short sentence containing WRITE_PATH_DOGFOOD_OK, calendar.events.insert/delete, drive.files.create/delete, and gmail.users.drafts.create/delete.",
        ].join("\n"),
      });
    } catch (error) {
      sendError = error;
    } finally {
      cleanupErrors.push(...(await cleanupGoogleWriteDogfoodArtifacts(broker, accountHint, created)));
    }

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    const audit = store.listPermissionAudit(100).filter((entry) => entry.threadId === thread.id && entry.toolName === "google_workspace_call");
    await writeGoogleWritePathDogfoodArtifact({
      accountHint,
      marker,
      answer,
      tools,
      googleCalls,
      audit: audit.map((entry) => ({
        toolName: entry.toolName,
        risk: entry.risk,
        decision: entry.decision,
        decisionSource: entry.decisionSource,
        detail: entry.detail,
        grantId: entry.grantId,
      })),
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
      cleanupErrors,
      sendError: sendError instanceof Error ? sendError.message : sendError ? String(sendError) : undefined,
    });
    if (sendError) throw sendError;
    expect(cleanupErrors).toEqual([]);

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls.map((call) => call.methodId)).toEqual(
      expect.arrayContaining([
        "calendar.events.insert",
        "calendar.events.delete",
        "drive.files.create",
        "drive.files.delete",
        "gmail.users.drafts.create",
        "gmail.users.drafts.delete",
      ]),
    );
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "calendar.events.insert", "calendar-insert");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "calendar.events.delete", "calendar-delete");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "drive.files.create", "drive-create");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "drive.files.delete", "drive-delete");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "gmail.users.drafts.create", "gmail-draft-create");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "gmail.users.drafts.delete", "gmail-draft-delete");
    expect(permissionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "google_workspace_call", title: expect.stringContaining("data mutation") }),
        expect.objectContaining({ toolName: "google_workspace_call", title: expect.stringContaining("draft change") }),
      ]),
    );
    expect(permissionRequests.map((request) => request.detail).join("\n")).toMatch(/Idempotency key: .+calendar-insert/);
    expect(audit.filter((entry) => entry.decision === "allowed").length).toBeGreaterThanOrEqual(6);
    expect(answer.replace(/\\/g, "")).toContain("WRITE_PATH_DOGFOOD_OK");
    expect(answer).toContain("calendar.events.insert");
    expect(answer).toContain("drive.files.create");
    expect(answer).toContain("gmail.users.drafts.create");
  }, 360_000);

  itRealGoogleWritePath("uploads Drive content and creates Gmail draft attachments through Pi against real Google", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const baseGoogleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const marker = `ambient-write-attachment-dogfood-${randomUUID()}`;
    await mkdir(join(workspacePath, "uploads"), { recursive: true });
    await mkdir(join(workspacePath, "attachments"), { recursive: true });
    await writeFile(join(workspacePath, "uploads", "real-google-upload.txt"), `Ambient real Drive upload dogfood create ${marker}\n`, "utf8");
    await writeFile(join(workspacePath, "uploads", "real-google-upload-updated.txt"), `Ambient real Drive upload dogfood update ${marker}\n`, "utf8");
    await writeFile(join(workspacePath, "attachments", "real-google-draft-attachment.txt"), `Ambient real Gmail attachment dogfood ${marker}\n`, "utf8");
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const created: GoogleWriteDogfoodCreatedIds = {};
    const cleanupErrors: string[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...baseGoogleTools,
          call: async (call) => {
            googleCalls.push(call);
            return callTrackedGoogleWriteDogfoodMethod(broker, accountHint, call, created);
          },
        },
      },
    );

    const thread = store.createThread("Google real upload and draft attachment dogfood");
    let sendError: unknown;
    try {
      await runtime.send({
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [
          "This is a live Ambient Desktop write-path dogfood using my real Google Workspace account.",
          "Use only google_workspace_search_methods and google_workspace_call. Do not use shell, bash, browser, filesystem, plugin install, read, write, edit, materialize, raw MIME, or base64 tools.",
          `Use accountHint exactly ${accountHint}. Use marker exactly ${marker}.`,
          "First search for and call drive.files.create with idempotencyKey marker-drive-upload-create, params {\"fields\":\"id,name,mimeType,trashed\"}, body {\"name\": marker + \" upload.txt\", \"mimeType\":\"text/plain\"}, and upload {\"path\":\"uploads/real-google-upload.txt\",\"mimeType\":\"text/plain\"}.",
          "Read the created Drive file id from the result. Then call drive.files.update with params {\"fileId\":\"<created file id>\",\"fields\":\"id,name,mimeType,trashed\"}, idempotencyKey marker-drive-upload-update, body {\"name\": marker + \" upload updated.txt\", \"mimeType\":\"text/plain\"}, and upload {\"path\":\"uploads/real-google-upload-updated.txt\",\"mimeType\":\"text/plain\"}.",
          "After the Drive update succeeds, call drive.files.delete with params {\"fileId\":\"<created file id>\"} and idempotencyKey marker-drive-upload-delete.",
          "Next search for and call gmail.users.drafts.create with params {\"userId\":\"me\"}, idempotencyKey marker-gmail-attachment-create, and gmailDraft {\"to\":\"nobody@example.test\",\"subject\": marker + \" attachment draft\",\"textBody\":\"Temporary Ambient Desktop Gmail attachment dogfood draft. Do not send.\",\"attachments\":[{\"path\":\"attachments/real-google-draft-attachment.txt\",\"mimeType\":\"text/plain\"}]}.",
          "Read the created Gmail draft id from the result. Then call gmail.users.drafts.delete with params {\"userId\":\"me\",\"id\":\"<created draft id>\"} and idempotencyKey marker-gmail-attachment-delete.",
          "After both cleanup deletes succeed, answer with one short sentence containing WRITE_ATTACHMENT_DOGFOOD_OK, drive.files.create/update/delete, and gmail.users.drafts.create/delete.",
        ].join("\n"),
      });
    } catch (error) {
      sendError = error;
    } finally {
      cleanupErrors.push(...(await cleanupGoogleWriteDogfoodArtifacts(broker, accountHint, created)));
    }

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    const audit = store.listPermissionAudit(100).filter((entry) => entry.threadId === thread.id && entry.toolName === "google_workspace_call");
    await writeGoogleWriteAttachmentDogfoodArtifact({
      accountHint,
      marker,
      answer,
      tools,
      googleCalls,
      audit: audit.map((entry) => ({
        toolName: entry.toolName,
        risk: entry.risk,
        decision: entry.decision,
        decisionSource: entry.decisionSource,
        detail: entry.detail,
        grantId: entry.grantId,
      })),
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
      cleanupErrors,
      sendError: sendError instanceof Error ? sendError.message : sendError ? String(sendError) : undefined,
    });
    if (sendError) throw sendError;
    expect(cleanupErrors).toEqual([]);

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls.map((call) => call.methodId)).toEqual(
      expect.arrayContaining([
        "drive.files.create",
        "drive.files.update",
        "drive.files.delete",
        "gmail.users.drafts.create",
        "gmail.users.drafts.delete",
      ]),
    );
    expect(googleCalls.find((call) => call.methodId === "drive.files.create")).toEqual(
      expect.objectContaining({ upload: { path: "uploads/real-google-upload.txt", mimeType: "text/plain" } }),
    );
    expect(googleCalls.find((call) => call.methodId === "drive.files.update")).toEqual(
      expect.objectContaining({ upload: { path: "uploads/real-google-upload-updated.txt", mimeType: "text/plain" } }),
    );
    expect(googleCalls.find((call) => call.methodId === "gmail.users.drafts.create")).toEqual(
      expect.objectContaining({
        gmailDraft: expect.objectContaining({
          attachments: [{ path: "attachments/real-google-draft-attachment.txt", mimeType: "text/plain" }],
        }),
      }),
    );
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "drive.files.create", "drive-upload-create");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "drive.files.update", "drive-upload-update");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "drive.files.delete", "drive-upload-delete");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "gmail.users.drafts.create", "gmail-attachment-create");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "gmail.users.drafts.delete", "gmail-attachment-delete");
    expect(permissionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "google_workspace_call", title: expect.stringContaining("data mutation") }),
        expect.objectContaining({ toolName: "google_workspace_call", title: expect.stringContaining("draft change") }),
      ]),
    );
    expect(permissionRequests.map((request) => request.detail).join("\n")).toMatch(/Upload: workspace path uploads\/real-google-upload.txt; mimeType text\/plain/);
    expect(permissionRequests.map((request) => request.detail).join("\n")).toMatch(
      /Gmail draft: subject .+ attachment draft; to yes; attachments 1; attachment paths attachments\/real-google-draft-attachment.txt/,
    );
    expect(audit.filter((entry) => entry.decision === "allowed").length).toBeGreaterThanOrEqual(5);
    expect(answer.replace(/\\/g, "")).toContain("WRITE_ATTACHMENT_DOGFOOD_OK");
    expect(answer).toContain("drive.files.create");
    expect(answer).toMatch(/drive\.files\.(?:update|create\/update\/delete)/);
    expect(answer).toContain("gmail.users.drafts.create");
  }, 420_000);

  itRealGoogleWritePath("keeps Gmail send methods high-friction in dry-run live dogfood", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const marker = `ambient-send-policy-dogfood-${randomUUID()}`;
    const messageRaw = base64Url(
      [
        "To: nobody@example.test",
        `Subject: ${marker} dry run`,
        "",
        "This dry-run message must not be sent.",
      ].join("\r\n"),
    );
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
        },
      },
    );

    const thread = store.createThread("Google real Gmail send policy dry-run dogfood");
    let sendError: unknown;
    try {
      await runtime.send({
        threadId: thread.id,
        permissionMode: "workspace",
        collaborationMode: "agent",
        model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
        thinkingLevel: "minimal",
        content: [
          "This is a live Ambient Desktop Google send-policy dogfood. It must not send email.",
          "Use only google_workspace_search_methods and google_workspace_call. Do not use shell, bash, browser, filesystem, plugin install, read, write, edit, materialize, or non-Google tools.",
          `Use accountHint exactly ${accountHint}. Use marker exactly ${marker}.`,
          "Search for the Gmail draft send method, then call google_workspace_call with methodId exactly gmail.users.drafts.send, accountHint exactly the supplied accountHint, dryRun true, params {\"userId\":\"me\"}, body {\"id\":\"draft-dry-run-only\"}, and idempotencyKey marker-drafts-send-dry-run.",
          `Search for the Gmail direct message send method, then call google_workspace_call with methodId exactly gmail.users.messages.send, accountHint exactly the supplied accountHint, dryRun true, params {"userId":"me"}, body {"raw":"${messageRaw}"}, and idempotencyKey marker-messages-send-dry-run.`,
          "After both dry-run calls finish, answer with one short sentence containing SEND_POLICY_DOGFOOD_OK, DRY_RUN, gmail.users.drafts.send, and gmail.users.messages.send.",
        ].join("\n"),
      });
    } catch (error) {
      sendError = error;
    }

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    const audit = store.listPermissionAudit(100).filter((entry) => entry.threadId === thread.id && entry.toolName === "google_workspace_call");
    await writeGoogleSendPolicyDogfoodArtifact({
      accountHint,
      marker,
      answer,
      tools,
      googleCalls,
      audit: audit.map((entry) => ({
        toolName: entry.toolName,
        risk: entry.risk,
        decision: entry.decision,
        decisionSource: entry.decisionSource,
        detail: entry.detail,
        grantId: entry.grantId,
      })),
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
      sendError: sendError instanceof Error ? sendError.message : sendError ? String(sendError) : undefined,
    });
    if (sendError) throw sendError;

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ methodId: "gmail.users.drafts.send", dryRun: true }),
        expect.objectContaining({ methodId: "gmail.users.messages.send", dryRun: true }),
      ]),
    );
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "gmail.users.drafts.send", "drafts-send-dry-run");
    expectGoogleWriteCallIdempotencySuffix(googleCalls, "gmail.users.messages.send", "messages-send-dry-run");
    expect(permissionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ toolName: "google_workspace_call", title: expect.stringContaining("send external communication") }),
      ]),
    );
    const details = permissionRequests.map((request) => request.detail).join("\n");
    expect(details).toContain("Method: gmail.users.drafts.send");
    expect(details).toContain("Method: gmail.users.messages.send");
    expect(details).toMatch(/Side effect: external_communication/);
    expect(details).toMatch(/Dry run requested: yes/);
    expect(details).toMatch(/External communication: yes/);
    expect(answer.replace(/\\/g, "")).toContain("SEND_POLICY_DOGFOOD_OK");
    expect(answer).toContain("DRY_RUN");
    expect(answer).toContain("gmail.users.drafts.send");
    expect(answer).toContain("gmail.users.messages.send");
  }, 300_000);

  itRealGoogleLastMeeting("answers a natural-language last meeting of the week question through real Calendar reads", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const expected = await lastTimedCalendarEventThisWeek(broker, accountHint);
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      { googleWorkspace: realGoogleWorkspaceTools({ accountHint, adapter, broker }) },
    );

    const thread = store.createThread("Google real last meeting dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "What is my last meeting this week?",
        "Use the Google Workspace dynamic method broker to answer from my real primary Google Calendar.",
        `Use accountHint exactly ${accountHint}.`,
        "For this dogfood, this week is Monday May 4, 2026 00:00 through Monday May 11, 2026 00:00 in America/Phoenix.",
        "Treat meetings as timed Calendar events; ignore all-day events.",
        "Do not use shell, bash, browser, filesystem, plugin install, or non-Google tools.",
        "Answer with one short sentence containing GOOGLE_LAST_MEETING_DOGFOOD_OK, the event summary if one exists, and the event start/end time.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    await writeGoogleLastMeetingDogfoodArtifact({
      accountHint,
      answer,
      expected,
      tools,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });
    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(permissionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "google_workspace_call",
          risk: "plugin-tool",
          title: expect.stringContaining("content read"),
        }),
      ]),
    );
    expect(answer).toContain("GOOGLE_LAST_MEETING_DOGFOOD_OK");
    if (expected) {
      expect(answer).toContain(expected.summary);
    } else {
      expect(answer.toLowerCase()).toContain("no timed");
    }
  }, 300_000);

  itRealGoogleRlm("uses Lambda-RLM recentToolResults over full Google result JSON while showing a compact preview", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const expectedAccessRole = await calendarEventsListAccessRole(broker, accountHint);
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      { googleWorkspace: realGoogleWorkspaceTools({ accountHint, adapter, broker }) },
    );

    const thread = store.createThread("Google real Lambda-RLM recent tool result dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is a live Ambient Desktop dogfood for Google tool-result presentation and Lambda-RLM recentToolResults.",
        "First use google_workspace_search_methods with query exactly calendar events list, service calendar, and httpMethod GET.",
        `Then call google_workspace_call with methodId exactly calendar.events.list, accountHint exactly ${accountHint}, and params {"calendarId":"primary","timeMin":"2026-05-04T00:00:00-07:00","timeMax":"2026-05-11T00:00:00-07:00","singleEvents":true,"orderBy":"startTime","maxResults":10,"fields":"accessRole,items(summary,start,end)"}.`,
        "After the Google call returns, call long_context_process with taskType qa, question exactly: What is the top-level accessRole in the recent calendar.events.list JSON?",
        'Set recentToolResults exactly to {"toolNames":["google_workspace_call"],"maxResults":1}.',
        "Do not answer from the visible Google preview. The visible preview intentionally omits the accessRole field; use the appropriate read-only Ambient tool if exact recent tool-result fields require deeper inspection.",
        "Do not use shell, bash, browser, filesystem, plugin install, or any tools except google_workspace_search_methods, google_workspace_call, and long_context_process.",
        "After long_context_process returns, answer with one short sentence containing GOOGLE_RLM_RECENT_TOOL_RESULT_OK and the accessRole value.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    const googleCallResultPreview = latestToolResultSection(store, thread.id, "google_workspace_call");
    await writeGoogleRlmDogfoodArtifact({
      accountHint,
      expectedAccessRole,
      answer,
      tools,
      googleCallResultPreview,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(tools).toContain("long_context_process");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(permissionRequests).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          toolName: "google_workspace_call",
          risk: "plugin-tool",
          title: expect.stringContaining("content read"),
        }),
      ]),
    );
    expect(googleCallResultPreview).toContain("Calendar events");
    expect(googleCallResultPreview).not.toContain('"accessRole"');
    expect(googleCallResultPreview).not.toContain(`accessRole:${expectedAccessRole}`);
    expect(answer).toContain("GOOGLE_RLM_RECENT_TOOL_RESULT_OK");
    expect(answer.toLowerCase()).toContain(expectedAccessRole.toLowerCase());
  }, 300_000);

  itRealGoogleGmailLabels("answers a subjective question through an arbitrary Gmail labels API call", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
        },
      },
    );

    const thread = store.createThread("Google real Gmail labels arbitrary API dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        'Using my connected Google account, find the current Gmail labels and answer: "What is the most unique email label that you can find in the current set?"',
        "Use the Google Workspace dynamic method broker. Search for the correct Gmail labels method first, then call it.",
        `Use accountHint exactly ${accountHint}.`,
        "Do not use shell, browser, filesystem, or plugin install tools.",
        "Answer with one short sentence containing GOOGLE_GMAIL_LABEL_DOGFOOD_OK, the label name, and briefly why it appears unique.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    await writeGoogleGmailLabelsDogfoodArtifact({
      accountHint,
      answer,
      tools,
      googleCalls,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "gmail.users.labels.list",
          accountHint,
          params: expect.objectContaining({ userId: "me" }),
        }),
      ]),
    );
    expect(permissionRequests).toEqual([]);
    expect(answer).toContain("GOOGLE_GMAIL_LABEL_DOGFOOD_OK");
  }, 300_000);

  itRealGoogleGmailLabels("discovers the Gmail labels API from a vague user-level prompt", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
        },
      },
    );

    const thread = store.createThread("Google real Gmail labels vague API dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "What is the most unique email label that you can find in my connected Google account?",
        `Use accountHint exactly ${accountHint} if you need to choose an account.`,
        "Use available Ambient tools, but do not use shell, browser, filesystem, or plugin install tools.",
        "Answer with one short sentence containing GOOGLE_GMAIL_LABEL_VAGUE_DOGFOOD_OK, the label name, and briefly why it appears unique.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    await writeGoogleGmailLabelsVagueDogfoodArtifact({
      accountHint,
      answer,
      tools,
      googleCalls,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "gmail.users.labels.list",
          accountHint,
          params: expect.objectContaining({ userId: "me" }),
        }),
      ]),
    );
    expect(answer).toContain("GOOGLE_GMAIL_LABEL_VAGUE_DOGFOOD_OK");
  }, 300_000);

  itRealGoogleDrivePoetry("searches Google Drive for likely poetry files through an arbitrary Drive API call", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
        },
      },
    );

    const thread = store.createThread("Google real Drive poetry arbitrary API dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "Search my connected Google Drive for files that look like they contain poetry or poems.",
        `Use accountHint exactly ${accountHint} if you need to choose an account.`,
        "Use available Ambient Google tools. Do not use shell, browser, filesystem, or plugin install tools.",
        "Do not quote file contents. Answer with GOOGLE_DRIVE_POETRY_DOGFOOD_OK, the best matching file names if any, and why they look relevant.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    await writeGoogleDrivePoetryDogfoodArtifact({
      accountHint,
      answer,
      tools,
      googleCalls,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "drive.files.list",
          accountHint,
          params: expect.objectContaining({
            q: expect.any(String),
          }),
        }),
      ]),
    );
    expect(answer).toContain("GOOGLE_DRIVE_POETRY_DOGFOOD_OK");
  }, 300_000);

  itRealGoogleDrivePoetry("exports and summarizes one likely poetry document through a second arbitrary Google API call", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
        },
      },
    );

    const thread = store.createThread("Google real Drive poetry document read dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "Search my connected Google Drive for files that look like they contain poetry or poems.",
        "Choose one Google Docs result, then export that selected document as text with google_workspace_call methodId exactly drive.files.export and params containing mimeType text/plain.",
        `Use accountHint exactly ${accountHint} if you need to choose an account.`,
        "Use available Ambient Google tools. If the export result points to a local exported file, use the read tool to inspect that file.",
        "Do not use shell, bash, browser, or plugin install tools.",
        "Do not quote poem text or reproduce lines. Answer with GOOGLE_DRIVE_POETRY_READ_DOGFOOD_OK, the selected file name, and a one-sentence non-quoting high-level summary of what the writing seems to be about.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    await writeGoogleDrivePoetryReadDogfoodArtifact({
      accountHint,
      answer,
      tools,
      googleCalls,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "drive.files.list",
          accountHint,
          params: expect.objectContaining({ q: expect.any(String) }),
        }),
      ]),
    );
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "drive.files.export",
          accountHint,
          params: expect.objectContaining({ mimeType: "text/plain" }),
        }),
      ]),
    );
    expect(tools).not.toContain("bash");
    expect(answer).toContain("GOOGLE_DRIVE_POETRY_READ_DOGFOOD_OK");
  }, 300_000);

  itRealGoogleDrivePoetry("uses Drive export as the default Google Docs text fallback", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
        },
      },
    );

    const thread = store.createThread("Google real Docs export fallback dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "This is an Ambient Desktop Google Docs fallback dogfood.",
        "Find one Google Docs file in my connected Google Drive that likely contains poetry or poems, read enough of its text to summarize it at a high level, and do not quote the document.",
        "Do not call docs.documents.get. For this dogfood, use Drive export as the Google Docs text fallback.",
        "First call google_workspace_call with methodId exactly drive.files.list, params {\"q\":\"mimeType='application/vnd.google-apps.document'\",\"pageSize\":20,\"fields\":\"files(id,name,mimeType)\"}, and the supplied accountHint.",
        "Choose the most poetry-like Google Docs result from that list, then call google_workspace_call with methodId exactly drive.files.export and params {\"fileId\":\"<chosen file id>\",\"mimeType\":\"text/plain\"}.",
        `Use accountHint exactly ${accountHint} if you need to choose an account.`,
        "Do not use shell, bash, browser, filesystem, plugin install, materialize, read, write, or edit tools.",
        "Answer with one short sentence containing GOOGLE_DOCS_EXPORT_FALLBACK_DOGFOOD_OK, the selected file name, and a non-quoting summary.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    await writeGoogleDriveDocsFallbackDogfoodArtifact({
      accountHint,
      answer,
      tools,
      googleCalls,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_call");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "drive.files.list",
          accountHint,
          params: expect.objectContaining({ q: expect.any(String) }),
        }),
        expect.objectContaining({
          methodId: "drive.files.export",
          accountHint,
          params: expect.objectContaining({ mimeType: "text/plain" }),
        }),
      ]),
    );
    expect(googleCalls.map((call) => call.methodId)).not.toContain("docs.documents.get");
    expect(answer).toContain("GOOGLE_DOCS_EXPORT_FALLBACK_DOGFOOD_OK");
  }, 300_000);

  itRealGoogleDrivePoetry("exports a Google Drive document as a managed PDF handle and materializes it explicitly", async () => {
    const { accountHint, adapter } = await resolveGoogleWorkspaceLiveDogfoodRuntime("workspace");
    const broker = new GoogleWorkspaceMethodBroker(adapter);
    const googleTools = realGoogleWorkspaceTools({ accountHint, adapter, broker });
    const googleCalls: GoogleWorkspaceCallInput[] = [];
    const materializedFiles: GoogleWorkspaceMaterializeFileInput[] = [];
    const modules = await loadRuntimeModules();
    runtime = new modules.AgentRuntime(
      store,
      new modules.BrowserService(() => store.getWorkspace()),
      new modules.BrowserCredentialStore(() => store.getWorkspace(), safeStorage),
      () => undefined,
      {
        request: async (request) => {
          permissionRequests.push(request);
          return { allowed: true, mode: "allow_once" };
        },
        denyThread: () => undefined,
      },
      {
        googleWorkspace: {
          ...googleTools,
          call: async (call) => {
            googleCalls.push(call);
            return googleTools.call(call);
          },
          materializeFile: async (input) => {
            materializedFiles.push(input);
            return googleTools.materializeFile(input);
          },
        },
      },
    );

    const thread = store.createThread("Google real Drive managed PDF materialization dogfood");
    await runtime.send({
      threadId: thread.id,
      permissionMode: "full-access",
      collaborationMode: "agent",
      model: process.env.AMBIENT_GOOGLE_SETUP_CHAT_MODEL ?? AMBIENT_DEFAULT_MODEL,
      thinkingLevel: "minimal",
      content: [
        "Search my connected Google Drive for files that look like they contain poetry or poems.",
        "Choose one Google Docs result, then export that selected document as a PDF with google_workspace_call methodId exactly drive.files.export and params containing mimeType application/pdf.",
        "The PDF export should return a managed file handle. Save that handle into the current workspace at exports/google-poetry-dogfood.pdf using google_workspace_materialize_file.",
        `Use accountHint exactly ${accountHint} if you need to choose an account.`,
        "Do not use shell, bash, browser, filesystem, plugin install, read, write, or edit tools.",
        "Answer with one short sentence containing GOOGLE_DRIVE_PDF_MATERIALIZE_DOGFOOD_OK and the workspace path exports/google-poetry-dogfood.pdf.",
      ].join("\n"),
    });

    const answer = lastAssistantContent(store, thread.id);
    const tools = threadToolNames(store, thread.id);
    const materialized = await stat(join(workspacePath, "exports/google-poetry-dogfood.pdf"));
    await writeGoogleDrivePdfMaterializeDogfoodArtifact({
      accountHint,
      answer,
      tools,
      googleCalls,
      materializedFiles,
      materializedBytes: materialized.size,
      permissionRequests: permissionRequests.map((request) => ({
        toolName: request.toolName,
        title: request.title,
        risk: request.risk,
        detail: request.detail,
      })),
    });

    expect(tools).toContain("google_workspace_search_methods");
    expect(tools).toContain("google_workspace_call");
    expect(tools).toContain("google_workspace_materialize_file");
    expect(unwantedToolNames(tools)).toEqual([]);
    expect(googleCalls).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          methodId: "drive.files.export",
          accountHint,
          params: expect.objectContaining({ mimeType: "application/pdf" }),
        }),
      ]),
    );
    expect(materializedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "exports/google-poetry-dogfood.pdf",
        }),
      ]),
    );
    expect(materialized.size).toBeGreaterThan(0);
    expect(answer).toContain("GOOGLE_DRIVE_PDF_MATERIALIZE_DOGFOOD_OK");
    expect(answer).toContain("exports/google-poetry-dogfood.pdf");
  }, 300_000);
});

interface RuntimeModules {
  AgentRuntime: typeof import("./googleWorkspaceAgentRuntimeDogfoodFacade").AgentRuntime;
  BrowserCredentialStore: typeof import("../browser/browserAgentRuntimeContract").BrowserCredentialStore;
  BrowserService: typeof import("../browser/browserAgentRuntimeContract").BrowserService;
  ProjectStore: typeof import("./googleWorkspaceProjectStoreFacade").ProjectStore;
}

interface GoogleWorkspaceDogfoodStub {
  calls: {
    readIntegration: number;
    installCli: number;
    startSetup: GoogleWorkspaceSetupInput[];
    importOAuthClient: Array<GoogleWorkspaceOAuthClientImportInput & { sourcePath: string }>;
    cancelSetup: number;
    validate: GoogleWorkspaceValidationInput[];
    searchMethods: GoogleWorkspaceSearchMethodsInput[];
    describeMethod: GoogleWorkspaceDescribeMethodInput[];
    call: GoogleWorkspaceCallInput[];
    materializeFile: GoogleWorkspaceMaterializeFileInput[];
  };
  tools: AgentRuntimeGoogleWorkspaceTools;
}

async function loadRuntimeModules(): Promise<RuntimeModules> {
  const [{ AgentRuntime }, { BrowserCredentialStore, BrowserService }, { ProjectStore }] = await Promise.all([
    import("./googleWorkspaceAgentRuntimeDogfoodFacade"),
    import("../browser/browserAgentRuntimeContract"),
    import("./googleWorkspaceProjectStoreFacade"),
  ]);
  return { AgentRuntime, BrowserCredentialStore, BrowserService, ProjectStore };
}

function createGoogleWorkspaceDogfoodStub(): GoogleWorkspaceDogfoodStub {
  const now = "2026-05-04T00:00:00.000Z";
  const account: AmbientPluginAuthAccountSummary = {
    id: "google-account-travis",
    accountId: "travis@example.test",
    label: "travis@example.test",
    email: "travis@example.test",
    status: "available",
    grantedScopes: ["gmail.readonly", "calendar.readonly", "drive.readonly"],
    connectedAt: now,
    updatedAt: now,
    lastValidatedAt: now,
  };
  const install: GoogleWorkspaceCliInstallState = {
    status: "completed",
    version: "0.22.3",
    platform: "darwin",
    arch: "arm64",
    binaryPath: "/tmp/ambient-gws-dogfood/gws",
    checksum: "dogfood-checksum",
    startedAt: now,
    finishedAt: now,
  };
  let setup: GoogleWorkspaceSetupState = {
    status: "idle",
    command: "login",
    configDir: "/tmp/ambient-gws-dogfood/config/travis@example.test",
  };
  const calls: GoogleWorkspaceDogfoodStub["calls"] = {
    readIntegration: 0,
    installCli: 0,
    startSetup: [],
    importOAuthClient: [],
    cancelSetup: 0,
    validate: [],
    searchMethods: [],
    describeMethod: [],
    call: [],
    materializeFile: [],
  };
  const method: GoogleWorkspaceMethodSummary =
    GOOGLE_WORKSPACE_METHOD_CATALOG.find((candidate) => candidate.id === "gmail.users.labels.list") ?? {
      id: "gmail.users.labels.list",
      service: "gmail",
      resource: "users.labels",
      method: "list",
      label: "List Gmail labels",
      description: "List Gmail labels.",
      httpMethod: "GET",
      path: "gmail/v1/users/{userId}/labels",
      scopes: ["https://www.googleapis.com/auth/gmail.readonly"],
      sideEffect: "metadata_read",
      dryRunSupported: false,
    };
  const validation: GoogleWorkspaceValidationResult = {
    account,
    identity: { email: "travis@example.test", displayName: "Travis Example", source: "hint" },
    checks: [
      { service: "identity", label: "Identity", ok: true },
      { service: "gmail", label: "Gmail labels", ok: true },
      { service: "calendar", label: "Calendar list", ok: true },
      { service: "drive", label: "Drive search", ok: true },
    ],
  };

  return {
    calls,
    tools: {
      readIntegration: () => {
        calls.readIntegration += 1;
        return integrationState(account, install, setup);
      },
      installCli: async () => {
        calls.installCli += 1;
        return install;
      },
      startSetup: (input) => {
        calls.startSetup.push(input);
        setup = {
          status: "running",
          command: "login",
          accountHint: input.accountHint,
          configDir: `/tmp/ambient-gws-dogfood/config/${input.accountHint ?? "default"}`,
          startedAt: now,
          authUrl: "https://accounts.google.com/o/oauth2/v2/auth?code=SHOULD_NOT_LEAK_AUTH_URL",
          openedAuthUrl: true,
          outputTail: "SHOULD_NOT_LEAK_OUTPUT_TAIL",
        };
        return setup;
      },
      importOAuthClient: async (input) => {
        calls.importOAuthClient.push(input);
        setup = {
          status: "completed",
          command: "setup",
          accountHint: input.accountHint,
          configDir: `/tmp/ambient-gws-dogfood/config/${input.accountHint ?? "default"}`,
          oauthClientConfigured: true,
          finishedAt: now,
        };
        return setup;
      },
      cancelSetup: () => {
        calls.cancelSetup += 1;
        setup = { ...setup, status: "canceled", finishedAt: now };
        return setup;
      },
      validate: async (input) => {
        calls.validate.push(input);
        setup = {
          ...setup,
          status: "completed",
          finishedAt: now,
          validation,
          discoveredEmail: "travis@example.test",
        };
        return validation;
      },
      searchMethods: (input): GoogleWorkspaceSearchMethodsResult => {
        calls.searchMethods.push(input);
        const result = searchGoogleWorkspaceMethods(input);
        return result.methods.length ? result : { methods: [method], truncated: false, catalogVersion: "dogfood" };
      },
      describeMethod: async (input) => {
        calls.describeMethod.push(input);
        return GOOGLE_WORKSPACE_METHOD_CATALOG.find((candidate) => candidate.id === input.methodId) ?? { ...method, id: input.methodId };
      },
      call: async (input): Promise<GoogleWorkspaceCallResult> => {
        calls.call.push(input);
        const selectedMethod = GOOGLE_WORKSPACE_METHOD_CATALOG.find((candidate) => candidate.id === input.methodId) ?? { ...method, id: input.methodId };
        if (input.methodId === "gmail.users.messages.attachments.get") {
          return {
            accountHint: input.accountHint,
            method: selectedMethod,
            dryRun: input.dryRun === true,
            result: {
              size: 17,
              file: {
                kind: "google_workspace_managed_file",
                handle: "gmail-attachment-handle",
                fileName: "gmail-attachment-attachment-1.bin",
                mimeType: "application/octet-stream",
                bytes: 17,
                storage: "ambient_managed_temp",
                sourceMethodId: "gmail.users.messages.attachments.get",
                availableToModel: false,
                materializeWith: "google_workspace_materialize_file",
                createdAt: now,
              },
            },
          };
        }
        if (input.methodId === "drive.files.create" && input.upload) {
          return {
            accountHint: input.accountHint,
            method: selectedMethod,
            dryRun: input.dryRun === true,
            result: {
              kind: "google_workspace_drive_file_content_write",
              sourceMethodId: "drive.files.create",
              operation: "create",
              upload: {
                path: input.upload.path,
                fileName: "google-upload-dogfood.txt",
                bytes: 30,
                mimeType: input.upload.mimeType,
              },
              response: { id: "drive-file-upload-1", name: "google-upload-dogfood.txt", mimeType: "text/plain" },
              createdAt: now,
            },
          };
        }
        if (input.methodId === "gmail.users.drafts.create" && input.gmailDraft) {
          return {
            accountHint: input.accountHint,
            method: selectedMethod,
            dryRun: input.dryRun === true,
            result: {
              kind: "google_workspace_gmail_draft_write",
              sourceMethodId: "gmail.users.drafts.create",
              operation: "create",
              subject: input.gmailDraft.subject,
              attachments: (input.gmailDraft.attachments ?? []).map((attachment) => ({
                path: attachment.path,
                fileName: attachment.fileName ?? "gmail-draft-dogfood.txt",
                bytes: 39,
                mimeType: attachment.mimeType ?? "application/octet-stream",
              })),
              response: { id: "gmail-draft-attachment-1", message: { id: "gmail-message-attachment-1" } },
              createdAt: now,
            },
          };
        }
        return {
          accountHint: input.accountHint,
          method: selectedMethod,
          dryRun: input.dryRun === true,
          result: { labels: [{ id: "INBOX", name: "INBOX" }] },
        };
      },
      materializeFile: async (input): Promise<GoogleWorkspaceMaterializeFileResult> => {
        calls.materializeFile.push(input);
        return {
          handle: input.handle,
          path: input.path ?? "Google Workspace Downloads/download.bin",
          bytes: 4,
          fileName: "download.bin",
          overwritten: input.overwrite === true,
        };
      },
    },
  };
}

function realGoogleWorkspaceTools(input: {
  accountHint: string;
  adapter: GoogleWorkspaceCliAdapter;
  broker: GoogleWorkspaceMethodBroker;
}): AgentRuntimeGoogleWorkspaceTools {
  const now = new Date().toISOString();
  const account: AmbientPluginAuthAccountSummary = {
    id: `gws:${input.accountHint}`,
    accountId: input.accountHint,
    label: input.accountHint,
    email: input.accountHint.includes("@") ? input.accountHint : undefined,
    status: "available",
    grantedScopes: ["gws:gmail", "gws:calendar", "gws:drive"],
    connectedAt: now,
    updatedAt: now,
    lastValidatedAt: now,
  };
  const install: GoogleWorkspaceCliInstallState = {
    status: "completed",
    version: "0.22.3",
    platform: process.platform,
    arch: process.arch,
    binaryPath: input.adapter.binaryPath(),
    finishedAt: now,
  };
  const setup: GoogleWorkspaceSetupState = {
    status: "completed",
    command: "login",
    accountHint: input.accountHint,
    configDir: input.adapter.configDir(input.accountHint),
    finishedAt: now,
  };

  return {
    readIntegration: () => integrationState(account, install, setup),
    installCli: async () => install,
    startSetup: () => setup,
    importOAuthClient: async (oauthClient) => ({ ...setup, accountHint: oauthClient.accountHint, oauthClientConfigured: true }),
    cancelSetup: () => setup,
    validate: async () => ({
      account,
      identity: { email: account.email, source: account.email ? "hint" : "gmail.profile" },
      checks: [{ service: "identity", label: "Real gws account supplied by dogfood harness", ok: true }],
    }),
    searchMethods: (search) => input.broker.searchMethods(search),
    describeMethod: (describe) => input.broker.describeMethod(describe),
    call: async (call) => {
      const method = await input.broker.describeMethod({ methodId: call.methodId });
      if (method.httpMethod !== "GET" && call.dryRun !== true) {
        throw new Error(`Real Google dogfood refused non-dry-run dynamic call for ${call.methodId}.`);
      }
      return input.broker.call(call);
    },
    materializeFile: (materialize) => input.broker.materializeFile(materialize),
  };
}

interface GoogleWriteDogfoodCreatedIds {
  calendarEventId?: string;
  driveFileId?: string;
  gmailDraftId?: string;
}

const realGoogleWriteDogfoodMethods = new Set([
  "calendar.events.insert",
  "calendar.events.delete",
  "drive.files.create",
  "drive.files.update",
  "drive.files.delete",
  "gmail.users.drafts.create",
  "gmail.users.drafts.delete",
]);

function expectGoogleWriteCallIdempotencySuffix(calls: GoogleWorkspaceCallInput[], methodId: string, suffix: string): void {
  const call = calls.find((entry) => entry.methodId === methodId);
  expect(call).toBeTruthy();
  expect(call?.idempotencyKey).toEqual(expect.stringMatching(new RegExp(`${escapeRegExp(suffix)}$`)));
}

async function callTrackedGoogleWriteDogfoodMethod(
  broker: GoogleWorkspaceMethodBroker,
  accountHint: string,
  call: GoogleWorkspaceCallInput,
  created: GoogleWriteDogfoodCreatedIds,
): Promise<GoogleWorkspaceCallResult> {
  if (!realGoogleWriteDogfoodMethods.has(call.methodId)) {
    throw new Error(`Real Google write dogfood refused dynamic call outside the low-risk allowlist: ${call.methodId}.`);
  }
  if (call.dryRun === true) {
    throw new Error(`Real Google write dogfood expected an actual write/cleanup call, not dry-run: ${call.methodId}.`);
  }
  const result = await broker.call({ ...call, accountHint: call.accountHint ?? accountHint });
  if (call.methodId === "calendar.events.insert") created.calendarEventId = googleWorkspaceResultId(result);
  if (call.methodId === "drive.files.create") created.driveFileId = googleWorkspaceResultId(result);
  if (call.methodId === "gmail.users.drafts.create") created.gmailDraftId = googleWorkspaceResultId(result);
  if (call.methodId === "calendar.events.delete" && stringParam(call.params, "eventId")) created.calendarEventId = undefined;
  if (call.methodId === "drive.files.delete" && stringParam(call.params, "fileId")) created.driveFileId = undefined;
  if (call.methodId === "gmail.users.drafts.delete" && stringParam(call.params, "id")) created.gmailDraftId = undefined;
  return result;
}

async function cleanupGoogleWriteDogfoodArtifacts(
  broker: GoogleWorkspaceMethodBroker,
  accountHint: string,
  created: GoogleWriteDogfoodCreatedIds,
): Promise<string[]> {
  const errors: string[] = [];
  const cleanup = async (methodId: string, params: Record<string, unknown>) => {
    try {
      await broker.call({ accountHint, methodId, params });
    } catch (error) {
      errors.push(`${methodId}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };
  if (created.calendarEventId) {
    await cleanup("calendar.events.delete", { calendarId: "primary", eventId: created.calendarEventId });
    created.calendarEventId = undefined;
  }
  if (created.driveFileId) {
    await cleanup("drive.files.delete", { fileId: created.driveFileId });
    created.driveFileId = undefined;
  }
  if (created.gmailDraftId) {
    await cleanup("gmail.users.drafts.delete", { userId: "me", id: created.gmailDraftId });
    created.gmailDraftId = undefined;
  }
  return errors;
}

function googleWorkspaceResultId(result: GoogleWorkspaceCallResult): string | undefined {
  const value = result.result;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const id = (value as { id?: unknown }).id;
  if (typeof id === "string" && id.trim()) return id.trim();
  const response = (value as { response?: unknown }).response;
  if (!response || typeof response !== "object" || Array.isArray(response)) return undefined;
  const responseId = (response as { id?: unknown }).id;
  return typeof responseId === "string" && responseId.trim() ? responseId.trim() : undefined;
}

function stringParam(params: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = params?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function base64Url(value: string): string {
  return Buffer.from(value, "utf8").toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function lastTimedCalendarEventThisWeek(
  broker: GoogleWorkspaceMethodBroker,
  accountHint: string,
): Promise<{ summary: string; start: string; end: string } | undefined> {
  const result = await broker.call({
    accountHint,
    methodId: "calendar.events.list",
    params: {
      calendarId: "primary",
      timeMin: "2026-05-04T00:00:00-07:00",
      timeMax: "2026-05-11T00:00:00-07:00",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 50,
      fields: "items(summary,start,end)",
    },
  });
  const value = result.result;
  const items = value && typeof value === "object" && Array.isArray((value as { items?: unknown }).items)
    ? (value as { items: unknown[] }).items
    : [];
  const timed = items
    .map((item) => calendarEventSummary(item))
    .filter((item): item is { summary: string; start: string; end: string } => Boolean(item))
    .sort((left, right) => left.end.localeCompare(right.end) || left.start.localeCompare(right.start));
  return timed.at(-1);
}

async function calendarEventsListAccessRole(broker: GoogleWorkspaceMethodBroker, accountHint: string): Promise<string> {
  const result = await broker.call({
    accountHint,
    methodId: "calendar.events.list",
    params: {
      calendarId: "primary",
      timeMin: "2026-05-04T00:00:00-07:00",
      timeMax: "2026-05-11T00:00:00-07:00",
      singleEvents: true,
      orderBy: "startTime",
      maxResults: 10,
      fields: "accessRole,items(summary,start,end)",
    },
  });
  const value = result.result;
  const accessRole = value && typeof value === "object" && !Array.isArray(value) ? (value as { accessRole?: unknown }).accessRole : undefined;
  if (typeof accessRole === "string" && accessRole.trim()) return accessRole.trim();
  throw new Error("Real Calendar events.list response did not include top-level accessRole.");
}

function calendarEventSummary(value: unknown): { summary: string; start: string; end: string } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const start = calendarDateTime(record.start);
  const end = calendarDateTime(record.end);
  if (!start || !end) return undefined;
  return {
    summary: typeof record.summary === "string" && record.summary.trim() ? record.summary.trim() : "(no title)",
    start,
    end,
  };
}

function calendarDateTime(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const dateTime = (value as { dateTime?: unknown }).dateTime;
  return typeof dateTime === "string" && dateTime.trim() ? dateTime.trim() : undefined;
}

async function writeGoogleLastMeetingDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-last-meeting-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleRlmDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-rlm-recent-tool-result-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleGmailLabelsDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-gmail-labels-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleGmailLabelsVagueDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-gmail-labels-vague-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleDrivePoetryDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-drive-poetry-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleDrivePoetryReadDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-drive-poetry-read-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleDriveDocsFallbackDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-drive-docs-fallback-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleDrivePdfMaterializeDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-drive-pdf-materialize-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleWritePathDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-write-path-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleWriteAttachmentDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-write-attachment-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

async function writeGoogleSendPolicyDogfoodArtifact(value: unknown): Promise<void> {
  const dir = join(repoRoot(), "test-results", "google-send-policy-dogfood");
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "latest.json"), `${JSON.stringify(value, null, 2)}\n`);
}

function integrationState(
  account: AmbientPluginAuthAccountSummary,
  install: GoogleWorkspaceCliInstallState,
  setup: GoogleWorkspaceSetupState,
): FirstPartyGoogleIntegrationState {
  return {
    enabled: true,
    authMode: "gws",
    install,
    setup,
    sidecar: {
      adapter: "gws",
      state: "available",
      binaryPath: install.binaryPath ?? "/tmp/ambient-gws-dogfood/gws",
      configDir: "/tmp/ambient-gws-dogfood/config",
      pending: setup.status === "running" ? 1 : 0,
      setupCommands: ["login", "validate"],
    },
    connectors: ["google.gmail", "google.calendar", "google.drive"].map((connectorId) => ({
      connectorId,
      providerId: "google-workspace",
      providerLabel: "Google Workspace",
      status: "available",
      accounts: [account],
    })),
  };
}

function threadTranscript(store: ProjectStore, threadId: string): string {
  return store
    .listMessages(threadId)
    .map((message) => message.content)
    .join("\n");
}

function lastAssistantContent(store: ProjectStore, threadId: string): string {
  return store
    .listMessages(threadId)
    .filter((message) => message.role === "assistant")
    .at(-1)?.content ?? "";
}

function threadToolNames(store: ProjectStore, threadId: string): string[] {
  return store
    .listMessages(threadId)
    .map((message) => (typeof message.metadata?.toolName === "string" ? message.metadata.toolName : undefined))
    .filter((toolName): toolName is string => Boolean(toolName));
}

function latestToolResultSection(store: ProjectStore, threadId: string, toolName: string): string {
  const content = store
    .listMessages(threadId)
    .filter((message) => message.metadata?.toolName === toolName)
    .at(-1)?.content;
  if (!content) return "";
  return content.split("\n\nResult\n").at(-1) ?? "";
}

function unwantedToolNames(toolNames: string[]): string[] {
  return toolNames.filter(
    (toolName) =>
      toolName === "bash" ||
      toolName.startsWith("browser_") ||
      toolName.startsWith("file_") ||
      toolName.startsWith("ambient_plugin_") ||
      toolName.startsWith("ambient_cli"),
  );
}

function ensureAmbientApiKeyEnv(): void {
  const existing = process.env.AMBIENT_API_KEY || process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
  if (existing?.trim()) {
    process.env.AMBIENT_API_KEY = existing.trim();
    return;
  }
  const keyFile = [
    process.env.AMBIENT_API_KEY_FILE,
    join(repoRoot(), "ignored-provider-key-file.txt"),
    join(dirname(repoRoot()), "ignored-provider-key-file.txt"),
    join(dirname(dirname(repoRoot())), "ignored-provider-key-file.txt"),
    join(homedir(), "ignored-provider-key-file.txt"),
    "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
  ].find((filePath): filePath is string => Boolean(filePath && existsSync(filePath)));
  if (!keyFile) {
    throw new Error("Set AMBIENT_API_KEY, AMBIENT_AGENT_AMBIENT_API_KEY, AMBIENT_API_KEY_FILE, or place ignored-provider-key-file.txt near the repo.");
  }
  const key = readFileSync(keyFile, "utf8").trim();
  if (!key) throw new Error(`Ambient API key file is empty: ${keyFile}`);
  process.env.AMBIENT_API_KEY = key;
}

function repoRoot(): string {
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..");
}
