import { describe, expect, it } from "vitest";

import {
  isSensitivePathAliasCandidate,
  redactSensitivePathsInText,
  sensitivePathAliasForDisplay,
  sensitivePathRef,
} from "./pathRedaction";

describe("pathRedaction", () => {
  it("keeps ordinary paths visible", () => {
    const text = "Read /Users/example/project/src/app.ts and docs/setup.md.";

    expect(redactSensitivePathsInText(text)).toEqual({
      text,
      redacted: false,
      replacementCount: 0,
      refs: [],
    });
    expect(isSensitivePathAliasCandidate("/Users/example/project/src/app.ts")).toBe(false);
  });

  it("creates stable non-path refs for secret-like paths", () => {
    const path = "/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt";
    const first = sensitivePathRef(path);
    const second = sensitivePathRef(path);

    expect(first).toEqual(second);
    expect(first.ref).toMatch(/^sensitive-path-ref:v1:[a-f0-9]{16}$/);
    expect(sensitivePathAliasForDisplay(path)).toBe(`<${first.ref}>`);
    expect(isSensitivePathAliasCandidate(path)).toBe(true);
  });

  it("replaces secret-like path tokens without literal redacted placeholders", () => {
    const input = [
      "Use --api-key-file=/Users/example/Documents/ambientCoder/ignored-provider-key-file.txt",
      "then inspect /Users/example/project/src/app.ts.",
    ].join(" ");

    const result = redactSensitivePathsInText(input);

    expect(result.redacted).toBe(true);
    expect(result.replacementCount).toBe(1);
    expect(result.text).toContain("--api-key-file=<sensitive-path-ref:v1:");
    expect(result.text).toContain("sensitive-path-ref:v1:");
    expect(result.text).toContain("/Users/example/project/src/app.ts");
    expect(result.text).not.toContain("ignored-provider-key-file.txt");
    expect(result.text).not.toContain("[REDACTED]");
  });

  it("preserves compact JSON structure when aliasing path values", () => {
    const input = "{\"path\":\"/tmp/ignored-provider-key-file.txt\",\"ordinary\":\"/tmp/src/index.ts\"}";

    const result = redactSensitivePathsInText(input);
    const parsed = JSON.parse(result.text);

    expect(result.replacementCount).toBe(1);
    expect(parsed.path).toMatch(/^<sensitive-path-ref:v1:[a-f0-9]{16}>$/);
    expect(parsed.ordinary).toBe("/tmp/src/index.ts");
    expect(result.text).not.toContain("ignored-provider-key-file.txt");
  });

  it("aliases full quoted sensitive paths that contain spaces", () => {
    const input = "Debug \"/tmp/my project/ignored-provider-key-file.txt\" then inspect /tmp/my project/src/index.ts";

    const result = redactSensitivePathsInText(input);

    expect(result.replacementCount).toBe(1);
    expect(result.text).toContain("\"<sensitive-path-ref:v1:");
    expect(result.text).toContain("/tmp/my project/src/index.ts");
    expect(result.text).not.toContain("/tmp/my project/ignored-provider-key-file.txt");
    expect(result.refs[0]?.ref).toBe(sensitivePathRef("/tmp/my project/ignored-provider-key-file.txt").ref);
  });

  it("does not collapse quoted commands with mixed sensitive and ordinary paths", () => {
    const input = "Run \"cat /tmp/ignored-provider-key-file.txt && cat /tmp/project/src/index.ts\"";

    const result = redactSensitivePathsInText(input);

    expect(result.replacementCount).toBe(1);
    expect(result.text).toContain("cat <sensitive-path-ref:v1:");
    expect(result.text).toContain("/tmp/project/src/index.ts");
    expect(result.text).toContain("&&");
    expect(result.text).not.toContain("/tmp/ignored-provider-key-file.txt");
  });

  it("aliases Windows-style sensitive paths", () => {
    const input = "Inspect C:\\Users\\Neo\\secrets\\prod";

    const result = redactSensitivePathsInText(input);

    expect(result.replacementCount).toBe(1);
    expect(result.text).toMatch(/^Inspect <sensitive-path-ref:v1:[a-f0-9]{16}>$/);
    expect(result.text).not.toContain("C:\\Users\\Neo\\secrets\\prod");
  });

  it("aliases every sensitive path category recognized by the classifier", () => {
    const result = redactSensitivePathsInText(
      "Read /tmp/project/auth.json, /tmp/project/passwd.txt, /tmp/project/secrets.json, and /tmp/project/credentials.json",
    );

    expect(result.replacementCount).toBe(4);
    expect(result.text.match(/sensitive-path-ref:v1:/g)).toHaveLength(4);
    expect(result.text).not.toContain("auth.json");
    expect(result.text).not.toContain("passwd.txt");
    expect(result.text).not.toContain("secrets.json");
    expect(result.text).not.toContain("credentials.json");
  });

  it("does not alias ordinary URLs with sensitive-looking path names", () => {
    const input = "Fetch https://example.invalid/secrets.json before reading /tmp/project/secrets.json";

    const result = redactSensitivePathsInText(input);

    expect(result.replacementCount).toBe(1);
    expect(result.text).toContain("https://example.invalid/secrets.json");
    expect(result.text).not.toContain("/tmp/project/secrets.json");
  });

  it("does not treat env templates as sensitive paths", () => {
    expect(isSensitivePathAliasCandidate("/tmp/project/.env.example")).toBe(false);
    expect(redactSensitivePathsInText("Read /tmp/project/.env.example")).toMatchObject({
      redacted: false,
    });
  });
});
