import { z } from 'zod';
import { MCP_SCOPE } from '../constants/mcp-scopes';
import { defineTool, ToolDef } from './mcp-tool.util';

const FAILURE_KINDS = new Set(['bounced', 'complained', 'deferred']);

function kindOf(event: Record<string, unknown>): string {
  return typeof event.kind === 'string' ? event.kind : 'unknown';
}

/**
 * Diagnosing mail, not sending it.
 *
 * **There is deliberately no `mail_send` tool.** An agent able to send from a
 * verified domain is a phishing primitive with the operator's own reputation
 * behind it: outbound, irreversible, and indistinguishable at the receiver from
 * mail the operator wrote. Nothing here needs it — the questions an agent is
 * actually asked ("why didn't the invite arrive?", "is this domain
 * authenticated?") are all answered by reading. Sending stays with the API, the
 * CLI, and the product flows that have a human behind them.
 *
 * Read tier throughout. Recipient addresses are personal data, so these are
 * scoped separately from the rest of the read tier rather than folded into
 * `obs:read` — an agent granted logs does not thereby get everyone's email.
 */
export const MAIL_TOOLS: ToolDef[] = [
  defineTool({
    name: 'mail_readiness',
    routes: ['GET /mail/readiness'],
    description:
      'What still stands between Flui and a sent message, asked of the mail provider rather than guessed from a failed send. Returns ordered steps, each satisfied / automatable / manual / pending: `credential` (does the connected key cover the provider\'s email service at all), `domain` (is the sending domain registered), `dns` (are SPF and DKIM published and valid), `verification` (has the provider accepted the domain). A `manual` step carries the exact action and a console URL; `pending` means the provider is still working and is NOT an error. Pass `domain` to check a specific sending domain — omitted, only the credential is checked, which is enough to answer "is email set up here at all". Start here for any "mail is not arriving" question: three very different causes look identical from outside, and each sends the operator somewhere different.',
    scope: MCP_SCOPE.MAIL_READ,
    inputSchema: {
      domain: z.string().optional(),
    },
    // `GET /mail/readiness` asks whichever provider carries the transactional
    // scope — it delegates to the Scaleway path when that is the connected one,
    // so the answer is the same where it used to be right and correct where it
    // used to be Scaleway-shaped for a provider that is not Scaleway.
    run: (args, ctx) => ctx.api.get('/mail/readiness', { domain: args.domain }),
  }),

  defineTool({
    name: 'mail_events',
    routes: ['GET /mail/events'],
    description:
      "Delivery outcomes the provider reports for recently sent mail: queued, sent, delivered, deferred, bounced, complained. Each carries the recipient, the subject, the SMTP status code and the receiving server's own words — `550 5.7.1 SPF check failed for example.com` is usually the only text that says WHY, so quote it rather than paraphrasing. This is state, not history: the same message reappears with a changed verdict as it progresses, so match on message_id + recipient rather than counting rows. `since` is an ISO timestamp and is exclusive; the provider filters on when a message was CREATED, so a message sent this morning that bounces this afternoon is still found under this morning — widen the window when chasing a late failure.",
    scope: MCP_SCOPE.MAIL_READ,
    inputSchema: {
      since: z.string().optional(),
    },
    // The route backfills from the provider and then serves a page from the
    // store; its page size defaults to 50, so the cap is asked for explicitly.
    // 200 is the route's maximum, and the projection below already says when
    // the failures it shows are truncated.
    run: (args, ctx) =>
      ctx.api.get('/mail/events', { since: args.since, limit: 200 }),
    forModel: (events: unknown) => {
      const list = (events as Array<Record<string, unknown>>) ?? [];
      // The full list is unbounded and mostly repetition. A model needs the
      // failures and a count, not every delivered receipt.
      const failed = list.filter((e) => FAILURE_KINDS.has(kindOf(e)));
      return {
        total: list.length,
        by_kind: list.reduce<Record<string, number>>((acc, e) => {
          const kind = kindOf(e);
          acc[kind] = (acc[kind] ?? 0) + 1;
          return acc;
        }, {}),
        failures: failed.slice(0, 25),
        failures_truncated: failed.length > 25,
      };
    },
  }),

  defineTool({
    name: 'mail_suppressions',
    routes: ['GET /mail/suppressions'],
    description:
      'Addresses Flui has stopped writing to, and how far each stop reaches. `scope: all` means nothing can be delivered — a mailbox that does not exist, or someone who reported the sender as spam. `scope: bulk` means one-to-many mail only: that person left a mailing list and still receives their password resets, and treating the two the same is how someone gets silently locked out of their account. Check this before concluding that a specific person "never got the email" — a suppression is invisible from the application\'s side. Releasing an address is a write and is not available here; use `flui mail unsuppress` or the API.',
    scope: MCP_SCOPE.MAIL_READ,
    inputSchema: {},
    run: (_args, ctx) => ctx.api.get('/mail/suppressions'),
  }),
];
