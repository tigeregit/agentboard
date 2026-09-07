import type { SourceAdapter, ToolId } from "./types";
import { claudeCode } from "./adapters/claude-code";
import { codex } from "./adapters/codex";
import { cursor } from "./adapters/cursor";
import { opencode } from "./adapters/opencode";
import { copilotCli, copilotDesktop } from "./adapters/copilot";
import { vscodeCopilot } from "./adapters/vscode-copilot";
import { grokBuild } from "./adapters/grok-build";
import { pi } from "./adapters/pi";
import { kimi } from "./adapters/kimi";
import { deepseekHarness } from "./adapters/deepseek-harness";
import { trae } from "./adapters/trae";
import { workbuddy } from "./adapters/workbuddy";
import { minimax } from "./adapters/minimax";
import { zcode } from "./adapters/zcode";
import { chatgpt, claudeWeb } from "./webchat/imported";
import { openwebui } from "./webchat/openwebui";

export const ADAPTERS: SourceAdapter[] = [
  copilotCli,
  copilotDesktop,
  vscodeCopilot,
  opencode,
  codex,
  cursor,
  grokBuild,
  claudeCode,
  pi,
  kimi,
  deepseekHarness,
  trae,
  workbuddy,
  minimax,
  zcode,
  chatgpt,
  claudeWeb,
  openwebui,
];

export const TOOL_IDS = ADAPTERS.map((a) => a.id) as ToolId[];

export function adapterFor(tool: ToolId): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === tool);
}

export { TOOL_META, isToolId } from "./tool-meta";
