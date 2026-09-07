import type { ToolId } from "./types";

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
  aider: { name: "Aider", short: "Aider", vendor: "Aider AI", color: "#14b8a6" },
  "amazon-q": { name: "Amazon Q CLI", short: "Amazon Q", vendor: "AWS", color: "#ff9900" },
  kiro: { name: "Kiro CLI", short: "Kiro", vendor: "AWS", color: "#9a3412" },
  antigravity: { name: "Antigravity", short: "Antigravity", vendor: "Google", color: "#1a73e8" },
  cline: { name: "Cline / Roo / Kilo", short: "Cline", vendor: "Cline family", color: "#9333ea" },
  continue: { name: "Continue", short: "Continue", vendor: "Continue", color: "#0e7490" },
  pearai: { name: "PearAI", short: "PearAI", vendor: "PearAI", color: "#65a30d" },
  crush: { name: "Crush", short: "Crush", vendor: "Charm", color: "#ec4899" },
  forgecode: { name: "ForgeCode", short: "Forge", vendor: "Antinomy", color: "#b45309" },
  gemini: { name: "Gemini CLI", short: "Gemini", vendor: "Google", color: "#4285f4" },
  goose: { name: "Goose", short: "Goose", vendor: "Block", color: "#0f766e" },
  llm: { name: "llm CLI", short: "llm", vendor: "Datasette", color: "#6b7280" },
  ompi: { name: "oh-my-pi", short: "omp", vendor: "can1357", color: "#0284c7" },
  openhands: { name: "OpenHands", short: "OpenHands", vendor: "All Hands AI", color: "#ca8a04" },
  openinterpreter: { name: "Open Interpreter", short: "Interpreter", vendor: "Open Interpreter", color: "#525252" },
  qwen: { name: "Qwen Code", short: "Qwen", vendor: "Alibaba", color: "#615ced" },
  vibe: { name: "Vibe", short: "Vibe", vendor: "Mistral", color: "#f59e0b" },
  zed: { name: "Zed", short: "Zed", vendor: "Zed Industries", color: "#084ccf" },
  chatgpt: { name: "ChatGPT", short: "ChatGPT", vendor: "OpenAI", color: "#059669" },
  "claude-web": { name: "Claude.ai", short: "Claude.ai", vendor: "Anthropic", color: "#c2410c" },
  openwebui: { name: "Open WebUI", short: "Open WebUI", vendor: "self-hosted", color: "#334155" },
};

export const ALL_TOOL_IDS = Object.keys(TOOL_META) as ToolId[];

export function isToolId(v: string): v is ToolId {
  return Object.prototype.hasOwnProperty.call(TOOL_META, v);
}
