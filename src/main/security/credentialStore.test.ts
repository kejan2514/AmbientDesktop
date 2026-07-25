import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const originalAmbientApiKey = process.env.AMBIENT_API_KEY;
const originalAgentAmbientApiKey = process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
const originalAmbientApiKeyFile = process.env.AMBIENT_API_KEY_FILE;
const originalAgentAmbientApiKeyFile = process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE;
const originalAmbientProvider = process.env.AMBIENT_PROVIDER;
const originalAmbientLlmProvider = process.env.AMBIENT_LLM_PROVIDER;
const originalGmiCloudApiKey = process.env.GMI_CLOUD_API_KEY;
const originalGmiApiKey = process.env.GMI_API_KEY;
const originalGmiCloudApiKeyFile = process.env.GMI_CLOUD_API_KEY_FILE;
const originalGmiCloudBaseUrl = process.env.GMI_CLOUD_BASE_URL;
const originalGmiCloudModel = process.env.GMI_CLOUD_MODEL;
const originalCwd = process.cwd();

let testCwd: string | undefined;

describe("credentialStore", () => {
  beforeEach(async () => {
    testCwd = await mkdtemp(join(tmpdir(), "ambient-credential-cwd-"));
    process.chdir(testCwd);
    delete process.env.AMBIENT_PROVIDER;
    delete process.env.AMBIENT_LLM_PROVIDER;
    delete process.env.AMBIENT_API_KEY_FILE;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY_FILE;
    delete process.env.GMI_CLOUD_API_KEY;
    delete process.env.GMI_API_KEY;
    delete process.env.GMI_CLOUD_API_KEY_FILE;
    delete process.env.GMI_CLOUD_BASE_URL;
    delete process.env.GMI_CLOUD_MODEL;
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalAmbientApiKey === undefined) {
      delete process.env.AMBIENT_API_KEY;
    } else {
      process.env.AMBIENT_API_KEY = originalAmbientApiKey;
    }
    if (originalAgentAmbientApiKey === undefined) {
      delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    } else {
      process.env.AMBIENT_AGENT_AMBIENT_API_KEY = originalAgentAmbientApiKey;
    }
    restoreEnv("AMBIENT_PROVIDER", originalAmbientProvider);
    restoreEnv("AMBIENT_LLM_PROVIDER", originalAmbientLlmProvider);
    restoreEnv("AMBIENT_API_KEY_FILE", originalAmbientApiKeyFile);
    restoreEnv("AMBIENT_AGENT_AMBIENT_API_KEY_FILE", originalAgentAmbientApiKeyFile);
    restoreEnv("GMI_CLOUD_API_KEY", originalGmiCloudApiKey);
    restoreEnv("GMI_API_KEY", originalGmiApiKey);
    restoreEnv("GMI_CLOUD_API_KEY_FILE", originalGmiCloudApiKeyFile);
    restoreEnv("GMI_CLOUD_BASE_URL", originalGmiCloudBaseUrl);
    restoreEnv("GMI_CLOUD_MODEL", originalGmiCloudModel);
    vi.resetModules();
    vi.doUnmock("electron");
    if (testCwd) {
      await rm(testCwd, { recursive: true, force: true });
      testCwd = undefined;
    }
  });

  it("uses runtime Ambient API key environment values when Electron app storage is unavailable", async () => {
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: undefined,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    const credentialStore = await import("./credentialStore");
    process.env.AMBIENT_API_KEY = "ambient-runtime-key";

    expect(credentialStore.readAmbientApiKey()).toBe("ambient-runtime-key");
    expect(credentialStore.getAmbientApiKeySource()).toBe("env");
  });

  it("uses Ambient API key file environment values when Electron app storage is unavailable", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "ambient-credential-store-"));
    const keyFile = join(userDataPath, "ignored-provider-key-file.txt");
    await writeFile(keyFile, "ambient-file-key\n", "utf8");
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    process.env.AMBIENT_API_KEY_FILE = keyFile;
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: undefined,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    try {
      const credentialStore = await import("./credentialStore");

      expect(credentialStore.readAmbientApiKey()).toBe("ambient-file-key");
      expect(credentialStore.getAmbientApiKeySource()).toBe("env");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("saves and clears Ambient API keys without mutating process env", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "ambient-credential-store-"));
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: {
        getPath: () => userDataPath,
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    try {
      const credentialStore = await import("./credentialStore");
      credentialStore.saveAmbientApiKey(" saved-key ");

      expect(credentialStore.readAmbientApiKey()).toBe("saved-key");
      expect(credentialStore.getAmbientApiKeySource()).toBe("saved");
      expect(process.env.AMBIENT_API_KEY).toBeUndefined();
      expect(process.env.AMBIENT_AGENT_AMBIENT_API_KEY).toBeUndefined();

      credentialStore.clearSavedAmbientApiKey();
      expect(credentialStore.readAmbientApiKey()).toBeUndefined();
      expect(process.env.AMBIENT_API_KEY).toBeUndefined();
      expect(process.env.AMBIENT_AGENT_AMBIENT_API_KEY).toBeUndefined();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("times out stalled API key connectivity checks", async () => {
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: undefined,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    const credentialStore = await import("./credentialStore");
    const result = await credentialStore.testAmbientApiKey("ambient-test-key", "https://api.test", {
      timeoutMs: 5,
      fetchImpl: ((_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        })) as typeof fetch,
    });

    expect(result).toEqual({
      ok: false,
      message: "Ambient API key test timed out after 5ms.",
    });
  });

  it("keeps startup env fallback in memory without restoring it into process env", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "ambient-credential-store-"));
    process.env.AMBIENT_API_KEY = "startup-key";
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: {
        getPath: () => userDataPath,
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    try {
      const credentialStore = await import("./credentialStore");
      credentialStore.saveAmbientApiKey("saved-key");
      delete process.env.AMBIENT_API_KEY;
      credentialStore.clearSavedAmbientApiKey();

      expect(credentialStore.readAmbientApiKey()).toBe("startup-key");
      expect(credentialStore.getAmbientApiKeySource()).toBe("env");
      expect(process.env.AMBIENT_API_KEY).toBeUndefined();
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });

  it("uses GMI Cloud API key environment values when the startup provider override is active", async () => {
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    process.env.AMBIENT_PROVIDER = "gmi-cloud";
    process.env.GMI_CLOUD_API_KEY = "gmi-runtime-key";
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: undefined,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    const credentialStore = await import("./credentialStore");

    expect(credentialStore.getActiveAmbientProviderId()).toBe("gmi-cloud");
    expect(credentialStore.getActiveAmbientProviderLabel()).toBe("GMI Cloud");
    expect(credentialStore.getActiveAmbientProviderBaseUrl()).toBe("https://api.gmi-serving.com");
    expect(credentialStore.readAmbientApiKey()).toBe("gmi-runtime-key");
    expect(credentialStore.getAmbientApiKeySource()).toBe("env");
  });

  it("finds ignored GMI Cloud key files from a sibling primary checkout when running in a temp worktree", async () => {
    if (!testCwd) throw new Error("missing test cwd");
    const siblingCheckout = join(dirname(testCwd), "ambientCoder");
    await mkdir(siblingCheckout, { recursive: true });
    await writeFile(join(siblingCheckout, "ignored-provider-key-file.txt"), "gmi-sibling-key\n", "utf8");
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    delete process.env.GMI_CLOUD_API_KEY;
    delete process.env.GMI_API_KEY;
    process.env.AMBIENT_PROVIDER = "gmi-cloud";
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: undefined,
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    try {
      const credentialStore = await import("./credentialStore");

      expect(credentialStore.readAmbientApiKey()).toBe("gmi-sibling-key");
      expect(credentialStore.getAmbientApiKeySource()).toBe("env");
    } finally {
      await rm(siblingCheckout, { recursive: true, force: true });
    }
  });

  it("saves GMI Cloud keys separately from Ambient keys when the override is active", async () => {
    const userDataPath = await mkdtemp(join(tmpdir(), "gmi-credential-store-"));
    process.env.AMBIENT_PROVIDER = "gmi-cloud";
    delete process.env.AMBIENT_API_KEY;
    delete process.env.AMBIENT_AGENT_AMBIENT_API_KEY;
    delete process.env.GMI_CLOUD_API_KEY;
    delete process.env.GMI_API_KEY;
    process.env.GMI_CLOUD_API_KEY_FILE = join(userDataPath, "missing-gmi-key.txt");
    vi.resetModules();
    vi.doMock("electron", () => ({
      app: {
        getPath: () => userDataPath,
      },
      safeStorage: {
        isEncryptionAvailable: () => true,
        encryptString: (value: string) => Buffer.from(value, "utf8"),
        decryptString: (value: Buffer) => value.toString("utf8"),
      },
    }));

    try {
      const credentialStore = await import("./credentialStore");
      credentialStore.saveAmbientApiKey(" saved-gmi-key ");

      expect(credentialStore.readAmbientApiKey()).toBe("saved-gmi-key");
      expect(credentialStore.getAmbientApiKeySource()).toBe("saved");
    } finally {
      await rm(userDataPath, { recursive: true, force: true });
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
