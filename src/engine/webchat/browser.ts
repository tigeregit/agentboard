import type { SessionDetail, SessionSummary, ToolId } from "../types";

/**
 * Reserved extension point for web chat boxes that expose no API and no
 * export (or whose export is too coarse): pulling history through a browser
 * session (extension, CDP/Playwright, or the product's private XHR endpoints).
 *
 * Nothing here is implemented on purpose. The contract exists so a future
 * provider can plug into the same engine without touching the index, the CLI
 * or the dashboard:
 *
 *   registerBrowserProvider({
 *     tool: "chatgpt",
 *     label: "ChatGPT via Chrome profile",
 *     async available() { ... },
 *     async listConversations() { ... },
 *     async fetchConversation(id) { ... },
 *   });
 *
 * The indexer will treat providers exactly like `api` strategies: enumerate,
 * fingerprint by `updatedAt`, and load details lazily.
 */
export interface BrowserConversationRef {
  id: string;
  title?: string;
  updatedAt?: string;
}

export interface BrowserChatProvider {
  tool: ToolId;
  label: string;
  /** Whether the browser context (profile, cookies, extension bridge) is usable right now. */
  available(): Promise<boolean>;
  listConversations(): Promise<BrowserConversationRef[]>;
  fetchConversation(ref: BrowserConversationRef): Promise<SessionDetail | null>;
}

const providers: BrowserChatProvider[] = [];

export function registerBrowserProvider(p: BrowserChatProvider): void {
  providers.push(p);
}

export function browserProviders(): readonly BrowserChatProvider[] {
  return providers;
}

export function browserProviderFor(summary: SessionSummary): BrowserChatProvider | undefined {
  return providers.find((p) => p.tool === summary.tool);
}
