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
import { aider } from "./adapters/aider";
import { amazonQ } from "./adapters/amazon-q";
import { kiro } from "./adapters/kiro";
import { antigravity } from "./adapters/antigravity";
import { cline } from "./adapters/cline";
import { continueDev } from "./adapters/continue";
import { pearai } from "./adapters/pearai";
import { crush } from "./adapters/crush";
import { forgecode } from "./adapters/forgecode";
import { gemini } from "./adapters/gemini";
import { goose } from "./adapters/goose";
import { llm } from "./adapters/llm";
import { ompi } from "./adapters/ompi";
import { openhands } from "./adapters/openhands";
import { openinterpreter } from "./adapters/openinterpreter";
import { qwen } from "./adapters/qwen";
import { vibe } from "./adapters/vibe";
import { zed } from "./adapters/zed";
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
  gemini,
  qwen,
  antigravity,
  amazonQ,
  kiro,
  aider,
  cline,
  continueDev,
  pearai,
  crush,
  forgecode,
  goose,
  llm,
  ompi,
  openhands,
  openinterpreter,
  vibe,
  zed,
  chatgpt,
  claudeWeb,
  openwebui,
];

export const TOOL_IDS = ADAPTERS.map((a) => a.id) as ToolId[];

export function adapterFor(tool: ToolId): SourceAdapter | undefined {
  return ADAPTERS.find((a) => a.id === tool);
}

export { TOOL_META, isToolId } from "./tool-meta";
