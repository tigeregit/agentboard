#!/usr/bin/env node
// Thin launcher so `npx agentboard` / `npm link` work without a build step.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const tsx = require.resolve("tsx/cli");
const main = path.join(here, "..", "src", "cli", "main.ts");

const child = spawn(process.execPath, ["--no-warnings", tsx, main, ...process.argv.slice(2)], { stdio: "inherit" });
child.on("exit", (code) => process.exit(code ?? 0));
