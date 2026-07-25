import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { agentHarnessVariantForId } from "./agentHarnessVariant";
import { buildAgentBootstrapContext, isSecretLikePath } from "./agentBootstrapContext";

describe("agent bootstrap context", () => {
  it("does not produce context for baseline runs", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ambient-bootstrap-baseline-"));
    try {
      const result = await buildAgentBootstrapContext({
        workspacePath: workspace,
        permissionMode: "workspace",
        collaborationMode: "agent",
        variant: agentHarnessVariantForId("baseline"),
      });

      expect(result).toEqual({
        variantId: "baseline",
        enabled: false,
        chars: 0,
        truncated: false,
        omittedSecretLikeEntries: 0,
      });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("summarizes workspace scripts while redacting secret-like entries", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ambient-bootstrap-scripts-"));
    try {
      await mkdir(join(workspace, "src"));
      await writeFile(join(workspace, "Agents.md"), "# Agent notes\n", "utf8");
      await writeFile(join(workspace, "ignored-provider-key-file.txt"), "supersecret\n", "utf8");
      await writeFile(join(workspace, ".env"), "AMBIENT_API_KEY_FILE=<ignored-key-file>", "utf8");
      await writeFile(
        join(workspace, "package.json"),
        JSON.stringify(
          {
            packageManager: "pnpm@10.0.0",
            scripts: {
              test: "AMBIENT_API_KEY_FILE=<ignored-key-file> node --test",
              build: "vite build",
            },
          },
          null,
          2,
        ),
        "utf8",
      );

      const result = await buildAgentBootstrapContext({
        workspacePath: workspace,
        permissionMode: "workspace",
        collaborationMode: "agent",
        variant: agentHarnessVariantForId("bootstrap-scripts"),
        now: new Date("2026-05-09T00:00:00.000Z"),
      });

      expect(result.text).toContain("[Ambient Workspace Bootstrap]");
      expect(result.text).toContain("Variant: bootstrap-scripts");
      expect(result.text).toContain("Created: 2026-05-09T00:00:00.000Z");
      expect(result.text).toContain("Git: not a repository");
      expect(result.text).toContain("Agents.md");
      expect(result.text).toContain("src/");
      expect(result.text).toContain("test: AMBIENT_API_KEY_FILE=<ignored-key-file> node --test");
      expect(result.text).toContain("build: vite build");
      expect(result.text).toContain("sensitive-path-ref:v1:");
      expect(result.text).toContain("aliases are not filesystem paths");
      expect(result.text).not.toContain("supersecret");
      expect(result.text).not.toContain("ignored-provider-key-file.txt");
      expect(result.text).not.toContain(".env");
      expect(result.omittedSecretLikeEntries).toBeGreaterThanOrEqual(3);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("caps generated context at the variant budget", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ambient-bootstrap-capped-"));
    try {
      const scripts = Object.fromEntries(
        Array.from({ length: 30 }, (_, index) => [`script-${index}`, `node scripts/task-${index}.mjs --flag value`]),
      );
      await writeFile(join(workspace, "package.json"), JSON.stringify({ scripts }, null, 2), "utf8");
      await Promise.all(
        Array.from({ length: 40 }, (_, index) => mkdir(join(workspace, `workspace-section-${index}`))),
      );

      const result = await buildAgentBootstrapContext({
        workspacePath: workspace,
        permissionMode: "workspace",
        collaborationMode: "agent",
        variant: {
          ...agentHarnessVariantForId("bootstrap-scripts"),
          bootstrap: {
            ...agentHarnessVariantForId("bootstrap-scripts").bootstrap!,
            maxChars: 500,
          },
        },
        now: new Date("2026-05-09T00:00:00.000Z"),
        commandRunner: async () => ({ ok: false, stdout: "" }),
      });

      expect(result.truncated).toBe(true);
      expect(result.text?.length).toBeLessThanOrEqual(500);
      expect(result.text).toContain("Bootstrap truncated");
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });

  it("detects secret-like paths", () => {
    expect(isSecretLikePath("ignored-provider-key-file.txt")).toBe(true);
    expect(isSecretLikePath(".env")).toBe(true);
    expect(isSecretLikePath("config/secrets.json")).toBe(true);
    expect(isSecretLikePath("credentials.json")).toBe(true);
    expect(isSecretLikePath("src/index.ts")).toBe(false);
  });

  it("keeps ordinary changed paths visible while aliasing secret-like changed paths", async () => {
    const workspace = await mkdtemp(join(tmpdir(), "ambient-bootstrap-git-paths-"));
    try {
      await writeFile(join(workspace, "ignored-provider-key-file.txt"), "placeholder\n", "utf8");
      const result = await buildAgentBootstrapContext({
        workspacePath: workspace,
        permissionMode: "workspace",
        collaborationMode: "agent",
        variant: agentHarnessVariantForId("bootstrap-scripts"),
        now: new Date("2026-05-09T00:00:00.000Z"),
        commandRunner: async (_cwd, command, args) => {
          if (command === "git" && args.join(" ") === "rev-parse --is-inside-work-tree") return { ok: true, stdout: "true\n" };
          if (command === "git" && args.join(" ") === "branch --show-current") return { ok: true, stdout: "main\n" };
          if (command === "git" && args.join(" ") === "status --short") {
            return {
              ok: true,
              stdout: [
                " M src/index.ts",
                "?? ignored-provider-key-file.txt",
              ].join("\n"),
            };
          }
          return { ok: false, stdout: "" };
        },
      });

      expect(result.text).toContain("src/index.ts");
      expect(result.text).toContain("sensitive-path-ref:v1:");
      expect(result.text).toContain("sensitive path alias; not a filesystem path");
      expect(result.text).not.toContain("ignored-provider-key-file.txt");
      const aliases = result.text?.match(/sensitive-path-ref:v1:[a-f0-9]{16}/g) ?? [];
      expect(aliases.length).toBeGreaterThanOrEqual(2);
      expect(new Set(aliases).size).toBe(1);
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  });
});
