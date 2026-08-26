import { Injectable, Logger } from '@nestjs/common';
import { Actor } from '../../auth/utils/actor-context';
import { McpAuditRepository } from '../repositories/mcp-audit.repository';
import {
  OUTCOME_DEPARTED,
  PERMISSION_UNSTATED,
  REGISTER_SURFACE,
} from './register-surface';

/** What a door knows about one agent call before the handler has run. */
export interface AgentCallEntry {
  userId: string;
  actor?: Actor;
  /**
   * The declared route shape — `POST /applications/:id/deploy` — and never the
   * concrete path.
   *
   * It is the string a standing permission is stored under, so the register and
   * the concession name the same thing and `?tool=` narrows across both. A
   * concrete path would carry identifiers into a column the panel groups by,
   * and would change shape the day the framework changed how it reports a route.
   */
  action: string;
  /**
   * The permission the route declares, read off the same metadata the
   * permission gate enforced — or null when it declares none.
   */
  permission: string | null;
}

/**
 * The register, written from a door instead of from a tool.
 *
 * **Not a second mechanism.** Every row still goes through
 * {@link McpAuditRepository}, which is the one place `mcp_tool_call_logs` is
 * written; this adds a call site and a vocabulary, not a table and not a second
 * insert. That distinction is the whole of decision 162: the assistant grew its
 * own copy of "record a stopped turn" and the copy forgot the outcome, so the
 * register classified a call that stopped to ask as a call that did nothing.
 *
 * **Nothing here can refuse a call.** A register write that failed and took a
 * permitted request down with it would make the audit trail a source of
 * outages; the failure is logged and swallowed, the same shape the cycle
 * already uses to stamp a concession as used. It is awaited rather than left in
 * flight, deliberately: the rows this writes are the refusals an agent is about
 * to be told about, and an agent that reads its own register a moment later has
 * to find them there.
 */
@Injectable()
export class AgentCallRegister {
  private readonly logger = new Logger(AgentCallRegister.name);

  constructor(private readonly audit: McpAuditRepository) {}

  /**
   * The pause was already removed: a standing permission, or a spent "allow
   * once".
   *
   * `outcome` is what keeps this row from claiming more than a door can see —
   * see {@link OUTCOME_DEPARTED}. Route-level guards run after the global chain
   * and the handler after them; either can still refuse this call, and nothing
   * comes back here to say so.
   */
  departed(entry: AgentCallEntry, grantId: string | null): Promise<void> {
    return this.write(entry, {
      allowed: true,
      outcome: OUTCOME_DEPARTED,
      grantId,
    });
  }

  /**
   * The call stopped to ask. `allowed: true` on purpose — the MCP surface
   * settled this: counting a wait as a denial writes "the guard refused this
   * agent" into the row a revoke decision is made on. `outcome` is what says
   * nothing happened.
   */
  waiting(
    entry: AgentCallEntry,
    proposalId: string,
    code: string,
  ): Promise<void> {
    return this.write(entry, {
      allowed: true,
      outcome: 'input_required',
      proposalId,
      error: code,
    });
  }

  /** The person had already said no, and the same call came round again. */
  refused(
    entry: AgentCallEntry,
    proposalId: string | null,
    code: string,
  ): Promise<void> {
    return this.write(entry, { allowed: false, proposalId, error: code });
  }

  private async write(
    entry: AgentCallEntry,
    fact: {
      allowed: boolean;
      outcome?: string;
      error?: string;
      proposalId?: string | null;
      grantId?: string | null;
    },
  ): Promise<void> {
    try {
      await this.audit.record({
        userId: entry.userId,
        actor: entry.actor,
        tool: entry.action,
        // The permission the gate checked, or the word that admits there was
        // none to check. Never a plausible-looking guess: decision 152.
        scope: entry.permission ?? PERMISSION_UNSTATED,
        surface: REGISTER_SURFACE.API,
        allowed: fact.allowed,
        outcome: fact.outcome ?? null,
        error: fact.error ?? null,
        proposalId: fact.proposalId ?? null,
        grantId: fact.grantId ?? null,
        // Deliberately no arguments. The body reaches the cycle once, to be
        // hashed, and is thrown away — a `catalog_install` carries an
        // administrator password in it, and the register is a table built to be
        // read. What was acted on is named by the route shape and the binding
        // on the request this row points at.
        args: null,
      });
    } catch (error) {
      this.logger.warn(
        `Could not record ${entry.action} in the agent register: ${String(error)}`,
      );
    }
  }
}
