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

export function isToolId(v: string): v is ToolId {
  return (TOOL_IDS as string[]).includes(v);
}

/** Display metadata usable on the client (no Node imports). */
export const TOOL_META: Record<ToolId, { name: string; short: string; vendor: string; color: string }> = {
  "copilot-cli": { name: "Copilot CLI", short: "Copilot CLI", vendor: "GitHub", color: "#6e40c9" },
  "copilot-desktop": { name: "Copilot app", short: "Copilot app", vendor: "GitHub", color: "#8957e5" },
  "vscode-copilot": { name: "VS Code Copilot", short: "VS Code", vendor: "Microsoft", color: "#0078d4" },
  opencode: { name: "OpenCode", short: "OpenCode", vendor: "Anomaly", color: "#f97316" },
  codex: { name: "Codex", short: "Codex", vendor: "OpenAI", color: "#10a37f" },
  cursor: { name: "Cursor", short: "Cursor", vendor: "Anysphere", color: "#111827" },
  "grok-build": { name: "Grok Build", short: "Grok", vendor: "xAI", color: "#374151" },
  "claude-code": { name: "Claude Code", short: "Claude Code", vendor: "Anthropic", color: "#d97757" },
  pi: { name: "pi", short: "pi", vendor: "pi-mono", color: "#0ea5e9" },
  kimi: { name: "Kimi", short: "Kimi", vendor: "Moonshot", color: "#2563eb" },
  "deepseek-harness": { name: "DeepSeek Harness", short: "dsh", vendor: "DeepSeek", color: "#4f46e5" },
  trae: { name: "Trae", short: "Trae", vendor: "ByteDance", color: "#ef4444" },
  workbuddy: { name: "WorkBuddy", short: "WorkBuddy", vendor: "Tencent", color: "#0891b2" },
  minimax: { name: "MiniMax Code", short: "MiniMax", vendor: "MiniMax", color: "#e11d48" },
  zcode: { name: "ZCode", short: "ZCode", vendor: "Z.ai", color: "#7c3aed" },
  chatgpt: { name: "ChatGPT", short: "ChatGPT", vendor: "OpenAI", color: "#059669" },
  "claude-web": { name: "Claude.ai", short: "Claude.ai", vendor: "Anthropic", color: "#c2410c" },
  openwebui: { name: "Open WebUI", short: "Open WebUI", vendor: "self-hosted", color: "#334155" },
};
