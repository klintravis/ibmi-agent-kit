// Delivery of a sign-on page (signon-page design D2, D3): elicitation first, then the link. The hook never
// waits for the client: the elicitation is fired and not awaited, so a client that never answers cannot hold
// the per-account sign-on chain in core. Form mode is never requested; the password goes only to the page.
import { randomUUID } from "node:crypto";
import type { Server } from "@modelcontextprotocol/sdk/server/index.js";
import type { SignOnPageHook } from "@ibmi-agent-kit/core";
import { PAGE_TTL_MS, SignOnPages, TERMINAL, type Page } from "./signon-page.js";

// How long an elicited page may be unanswered before the next failure prints the link.
export const ELICIT_WINDOW_MS = 10_000;

const HAND_OVER =
  "Give this link to the user and ask them to open it in their own browser on this machine. Do not open it yourself and never ask them for the password in chat.";

export class SignOnOffers {
  readonly pages: SignOnPages;
  constructor(
    private server: Server,
    private o: { now?: () => number; cwd?: () => string } = {},
  ) {
    this.pages = new SignOnPages(o);
  }
  private now = () => (this.o.now ?? Date.now)();

  // An Engine: shutdown closes the listener.
  async shutdown(): Promise<void> {
    this.pages.close();
  }

  // The core hook. Awaits only the listener; an error here leaves core's own error standing.
  hook: SignOnPageHook = async (p, why) => {
    try {
      const page = await this.pages.offer(p, why);
      if (!page) return why === "rejected" ? `No page is offered again for ${p.user} on ${p.host}. Run \`ibmi-agent-kit credential set <profile>\` in a terminal, then restart the server.` : "";
      const what =
        why === "missing"
          ? `No password is stored for ${p.user} on ${p.host}.`
          : `The stored password for ${p.user} on ${p.host} was rejected, and it will not be sent again.`;
      return this.deliver(page, what, `Enter the password for ${p.user} on ${p.host}. It is stored on this computer only.`, "call this tool again");
    } catch {
      return ""; // the listener failed: core's own error stands
    }
  };

  // The `list_servers` offer when no profile exists: the text to append, or "" when none is due.
  async firstProfileText(): Promise<string> {
    try {
      const r = await this.pages.firstProfile();
      if (!r) return "";
      if ("refused" in r) return `\nNo setup page is offered: ${r.refused}\n`;
      return `\n${this.deliver(r.page, "No profile exists yet.", "Set up your first IBM i profile. The password is stored on this computer only.", "call list_servers again")}\n`;
    } catch {
      return "";
    }
  }

  private deliver(page: Page, what: string, message: string, again: string): string {
    this.elicit(page, message);
    // Waiting only while the client may still answer; a decline, a failure or 10 s hands over the link.
    if (page.elicitationId && !page.answered && this.now() - page.born < ELICIT_WINDOW_MS) {
      return `${what} A prompt for it was offered in the client. Ask the user to finish it, then ${again}. If no prompt appeared, ${again} for a link. ${TERMINAL}`;
    }
    return `${what} A one-time page on this computer takes it. ${HAND_OVER} Then ${again}.\n${page.url}\n${TERMINAL}`;
  }

  // Sent once per page, not awaited. A decline or any failure only marks the page answered.
  private elicit(page: Page, message: string) {
    if (page.elicitationId || !this.server.getClientCapabilities()?.elicitation?.url) return;
    const id = (page.elicitationId = randomUUID()); // not the token, and not in the link
    const answered = () => void (page.answered = true);
    this.server.elicitInput({ mode: "url", message, url: page.url, elicitationId: id }, { timeout: PAGE_TTL_MS }).then((r) => r.action === "accept" || answered(), answered);
    page.onAccepted = () => (page.answered ? undefined : this.server.createElicitationCompletionNotifier(id)());
  }
}
