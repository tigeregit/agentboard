import type { SourceAdapter } from "../types";
import { expand } from "../util/paths";
import { type ContinueFamily, familyDetect, familyLoad, familyScan } from "./continue-family";

/** Continue: `<$CONTINUE_GLOBAL_DIR|~/.continue>/sessions/<sessionId>.json` (see continue-family.ts). */
const FAMILY: ContinueFamily = {
  tool: "continue",
  name: "Continue",
  globalDir: () => expand(process.env.CONTINUE_GLOBAL_DIR?.trim() || "~/.continue"),
};

export const continueDev: SourceAdapter = {
  id: "continue",
  name: "Continue",
  vendor: "Continue",
  surface: "ide",
  configHints: ["CONTINUE_GLOBAL_DIR (default ~/.continue)"],
  strategies: [
    { kind: "file", status: "implemented", description: "~/.continue/sessions/<sessionId>.json (sessionId, title, workspaceDirectory, history[]{message, contextItems, toolCallStates}); sessions.json index only for dateCreated." },
    { kind: "api", status: "reserved", description: "Continue CLI (`cn serve`) exposes a local HTTP server without a session-list endpoint; hook reserved." },
  ],
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
