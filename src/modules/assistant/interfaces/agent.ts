import { McpTier } from '../../mcp/constants/mcp-scopes';
import { ChatActionRequest } from '../services/action-cycle-reach';
import { ChatCompletionMessage } from './chat-completion';

/** One executed tool call, surfaced to the UI for rendering. */
export interface AgentToolStep {
  toolCallId: string;
  name: string;
  ok: boolean;
  error?: string;
  /** Full tool output for direct UI rendering (e.g. a logs panel) — not sent back to the model. */
  result?: unknown;
}

/**
 * A browser step a tool hands back for the human to complete (surface-agnostic):
 * the dashboard renders it as a button, an MCP host shows it as text. The agent
 * never performs the flow; the URL/manifest is generated server-side.
 *  - 'open_url'    → open `url` (OAuth / install authorize).
 *  - 'submit_form' → POST `fields` (e.g. a GitHub App manifest) to `url`.
 */
export type UiAction =
  | { kind: 'open_url'; url?: string; label: string }
  | {
      kind: 'submit_form';
      url: string;
      fields: Record<string, string>;
      label: string;
    };

/** A state-changing tool call awaiting the user's confirmation. */
export interface PendingAction {
  toolCallId: string;
  name: string;
  arguments: Record<string, unknown>;
  tier: McpTier;
  /** Human-readable summary resolved server-side, e.g. "Uninstall Immich" — show this, not the raw id. */
  label: string;
  /**
   * Stable key for actions that affect the SAME target (e.g. all components of one
   * catalog install). The UI collapses entries sharing a groupKey into a single
   * confirmation, but must still approve every toolCallId in the group on confirm.
   */
  groupKey: string;
  /**
   * The action cycle's own request, when this call raised one.
   *
   * Present exactly where the person's click will be recorded as the answer to
   * that request, and absent everywhere else. That is not a coincidence in the
   * rendering, it is the rule: the chat answers for somebody only where it has
   * shown them what they are answering.
   */
  request?: ChatActionRequest;
}

/**
 * An async operation kicked off this turn (install, deploy, scale, uninstall, …). The
 * tool returns immediately with the handle; the UI renders a non-blocking progress
 * widget that polls `GET /infrastructure/operations/:operationId` until terminal — so
 * the completion is delivered for real, and the model never has to (falsely) promise it.
 */
export interface OperationPending {
  operationId: string;
  /** Human-readable summary resolved server-side, e.g. "Install MariaDB". */
  label: string;
  /** The tool that started it (e.g. app_install) — diagnostic, the UI keys on operationId. */
  name: string;
}

/**
 * A documentation link for a topic this turn is grounded in. Resolved deterministically
 * server-side from the routed KB sections (never composed by the model), so it always
 * points to a real docs.flui.cloud page. The UI renders these as clickable chips.
 */
export interface DocLink {
  title: string;
  url: string;
}

/**
 * Agent turn result. `messages` is the conversation to echo back (no system
 * message): on a pending_action the client confirms and re-sends it with the
 * approved tool-call ids; on a message it is the final assistant turn.
 */
export interface AgentResult {
  type: 'message' | 'pending_action';
  content?: string;
  pending?: PendingAction[];
  /** Browser steps surfaced this turn (GitHub setup/connect, …) for the UI to render. */
  uiActions?: UiAction[];
  /** Async operations started this turn — the UI polls each to a non-blocking progress widget. */
  operationPending?: OperationPending[];
  /** Documentation links for this turn's topics — the UI renders them as clickable chips. */
  docLinks?: DocLink[];
  steps: AgentToolStep[];
  messages: ChatCompletionMessage[];
}
