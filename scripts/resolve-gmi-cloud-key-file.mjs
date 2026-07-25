#!/usr/bin/env node
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const candidates = [
  join(repoRoot, "ignored-provider-key-file.txt"),
  join(dirname(repoRoot), "ignored-provider-key-file.txt"),
  join(dirname(repoRoot), "ambientCoder", "ignored-provider-key-file.txt"),
  join(homedir(), "ambientCoder", "ignored-provider-key-file.txt"),
  join(homedir(), "Documents", "ambientCoder", "ignored-provider-key-file.txt"),
];

const match = candidates.find((candidate) => existsSync(candidate));
if (match) process.stdout.write(match);
