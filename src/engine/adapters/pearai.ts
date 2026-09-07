import type { SourceAdapter } from "../types";
import { expand } from "../util/paths";
import { type ContinueFamily, familyDetect, familyLoad, familyScan } from "./continue-family";

/**
 * PearAI is a Continue fork that rebrands the global dir to `~/.pearai`; the
 * session store is byte-compatible (see continue-family.ts). It deliberately
 * ignores CONTINUE_GLOBAL_DIR so a Continue override is never scanned twice.
 */
const FAMILY: ContinueFamily = {
  tool: "pearai",
  name: "PearAI",
  globalDir: () => expand("~/.pearai"),
};

export const pearai: SourceAdapter = {
  id: "pearai",
  name: "PearAI",
  vendor: "PearAI",
  surface: "ide",
  configHints: ["~/.pearai (CONTINUE_GLOBAL_DIR is intentionally not honoured)"],
  strategies: [{ kind: "file", status: "implemented", description: "~/.pearai/sessions/<sessionId>.json (Continue session format: sessionId, title, workspaceDirectory, history[])." }],
  async detect() {
    return familyDetect(FAMILY);
  },
  async scan(ctx) {
    return familyScan(FAMILY, ctx);
  },
  async load(summary) {
    return familyLoad(FAMILY, summary);
  },
};
