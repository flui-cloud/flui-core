import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios, { AxiosInstance, AxiosResponse } from 'axios';
import type { Request } from 'express';
import {
  FLUI_SESSION_COOKIE,
  extractJwtFromFluiSessionCookie,
} from '../../auth/utils/cookie-extractor.util';
import {
  ProposalRefusal,
  readProposalRefusal,
} from '../../action-cycle/action-cycle.core';

/**
 * The credential a tool call travels on — **the caller's own, forwarded verbatim**.
 *
 * This is the whole answer to "how does a tool authenticate against the API".
 * The obvious alternative was to mint an internal impersonation token, and it is
 * the wrong one: a token the platform issues to itself is a new credential, and
 * a new credential is a new surface to scope, rotate, audit and eventually leak.
 * Nothing here issues anything. Whatever bytes authenticated the inbound MCP (or
 * assistant) request are replayed on the outbound one, so the principal on the
 * far side is the same principal, by construction rather than by mapping.
 *
 * Consequence, stated rather than hidden: a forwarded token expires exactly when
 * the caller's own token expires. Flui cannot refresh somebody else's
 * credential, and does not try — a 401 mid-conversation is reported as a 401 and
 * the client presents a fresh token. An API key, having no expiry, never sees it.
 */
export interface ForwardedCredential {
  /** The inbound `Authorization` header, unmodified. */
  authorization?: string;
  /** Only the `flui_session` cookie: the dashboard authenticates with it. */
  sessionCookie?: string;
}

/** Lift the credential off an inbound request. Nothing else is carried over. */
export function credentialFromRequest(req: Request): ForwardedCredential {
  const authorization = req.headers?.authorization;
  // Replaying the whole Cookie header would forward unrelated cookies to a
  // route that has no business seeing them; only the one that authenticates
  // travels. Read with the same parser the JWT strategy uses, so "what
  // authenticated the caller" and "what is forwarded" cannot drift apart.
  const session = extractJwtFromFluiSessionCookie(req);
  return {
    authorization:
      typeof authorization === 'string' ? authorization : undefined,
    sessionCookie: session ?? undefined,
  };
}

export function hasCredential(credential: ForwardedCredential): boolean {
  return !!credential.authorization || !!credential.sessionCookie;
}

/**
 * A refusal or failure that came back from the API, kept typed on purpose.
 *
 * HTTP flattens everything into a status and a sentence, and a flattened
 * refusal is the one thing an agent handles badly: it cannot tell "you may
 * never do this" from "try again in a moment", so it retries both. {@link
 * agentMessage} re-inflates the distinction into the behavioural note the
 * service-layer errors used to carry — which of these is worth retrying, and
 * what has to change first.
 */
export class McpApiError extends Error {
  constructor(
    readonly status: number | undefined,
    readonly detail: string,
    readonly method: string,
    readonly path: string,
    readonly code?: string,
    readonly transport?: string,
    /**
     * Set only when the refusal was the action cycle asking a person first.
     *
     * It is not a failure and must not be rendered as one: the tool layer turns
     * it into `input_required` with a link to the request, and the agent learns
     * the answer by retrying the identical call. Kept as a narrow, named shape
     * rather than a copy of the response body — a general bag would sooner or
     * later carry something out of a guard that had no business leaving it.
     */
    readonly proposal?: ProposalRefusal,
  ) {
    super(detail);
    this.name = 'McpApiError';
  }

  /**
   * True when the refusal came from a Flui guard rather than from a scope.
   *
   * A pending proposal is deliberately not one, even though it arrives as a
   * 403: nothing was denied, somebody was asked. Counting it as a denial would
   * write "the guard refused this agent" into the register for every call that
   * is merely waiting, which is the row a revoke decision gets made on.
   */
  get isAccessRefusal(): boolean {
    return this.status === 403 && !this.proposal;
  }

  get agentMessage(): string {
    const where = `${this.method} ${this.path}`;
    const tag = this.code ? ` [code: ${this.code}]` : '';
    if (this.transport) {
      return `The Flui API did not answer this tool call (${this.transport}) on ${where}. A call that never arrived changed nothing, but a mutation that timed out MAY still have been applied: read the current state before repeating it, and never repeat it twice.`;
    }
    // A wait, told as a wait. Every surface reaches this string — the assistant
    // loop has no multi-round-trip channel of its own — and an agent that reads
    // "refused" abandons the task a person is about to allow.
    if (this.proposal) {
      const at = this.proposal.decideUrl
        ? ` at ${this.proposal.decideUrl}`
        : '';
      return `Waiting on a person (HTTP 403) on ${where}: ${this.proposal.sentence}. NOTHING was changed. This is not a permission problem and not a bad argument — the person you act for has been asked to allow it${at}. Tell them what you asked for, then retry the IDENTICAL call once they have answered; varying the arguments raises a second request instead of getting past this one.`;
    }
    switch (true) {
      case this.status === 401:
        return `Refused: the credential this call carries was rejected (HTTP 401)${tag}: ${this.detail}. Flui forwards YOUR OWN credential and never mints one, so a rejection means it expired or was revoked. Do NOT retry with it — a fresh credential has to be presented before this call can work.`;
      case this.status === 403:
        return `Refused by Flui access control (HTTP 403)${tag} on ${where}: ${this.detail}. This is NOT a scope problem — this tool IS granted to you; the person or key you are acting for is not allowed on this particular resource. Do NOT retry: nothing you can change about the call changes the answer. Tell the user which resource was refused and that access to it has to be granted first.`;
      case this.status === 404:
        return `Not found (HTTP 404)${tag} on ${where}: ${this.detail}. It does not exist, or it is not yours to see. Do NOT retry with the same identifier — look it up first and use the id that comes back.`;
      case this.status === 409:
        return `Conflict (HTTP 409)${tag}: ${this.detail}. The resource changed underneath this call. Re-read its current state and decide again; do NOT repeat the same mutation blindly.`;
      case this.status === 429:
        return `Rate limited (HTTP 429)${tag}: ${this.detail}. Wait before trying again and do not loop.`;
      case this.status !== undefined && this.status >= 500:
        return `Flui failed to complete this call (HTTP ${this.status})${tag} on ${where}: ${this.detail}. This is a platform-side failure, not a bad argument. At most ONE retry, and only after saying what happened; if it fails again, report it instead of looping.`;
      default:
        return `Rejected as invalid (HTTP ${this.status ?? '?'})${tag} on ${where}: ${this.detail}. Fix the arguments before calling again — the same arguments will fail the same way.`;
    }
  }
}

/** The verbs a converted tool uses. Bound to one principal; never to a service. */
export interface McpApiCaller {
  get<T = unknown>(path: string, query?: Record<string, unknown>): Promise<T>;
  post<T = unknown>(path: string, body?: unknown): Promise<T>;
  put<T = unknown>(path: string, body?: unknown): Promise<T>;
  patch<T = unknown>(path: string, body?: unknown): Promise<T>;
  delete<T = unknown>(path: string): Promise<T>;
}

function messageFrom(body: unknown, fallback: string): string {
  if (typeof body === 'string' && body.trim()) return body;
  if (body && typeof body === 'object') {
    const obj = body as { message?: unknown; error?: unknown };
    const raw = obj.message ?? obj.error;
    if (typeof raw === 'string') return raw;
    if (Array.isArray(raw)) return raw.join('; ');
  }
  return fallback;
}

function codeFrom(body: unknown): string | undefined {
  if (body && typeof body === 'object') {
    const code = (body as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/**
 * Calls the Flui API over HTTP, as the principal whose credential it holds.
 *
 * The point of going over the wire rather than reaching for the service is that
 * the guards are decorations on the controllers: `AppAccessGuard`, the sandbox
 * route fence, the section and permission gates all sit on the request path and
 * on nothing else. An in-process call walks past every one of them; a real
 * request cannot. So this client is not an optimisation or an abstraction — it
 * IS the enforcement point.
 *
 * It calls this very process, over loopback, so the request re-enters the same
 * pipeline with the same database and the same guards. That costs one local
 * socket per tool call, which is the price of the guards being real.
 */
@Injectable()
export class McpApiClient {
  private readonly http: AxiosInstance;

  constructor(private readonly config: ConfigService) {
    this.http = axios.create({
      baseURL: this.baseUrl(),
      timeout: Number(this.config.get('MCP_SELF_API_TIMEOUT_MS') ?? 120_000),
      // Statuses are read here, not thrown by axios, so one place decides what
      // each one means to an agent.
      validateStatus: () => true,
      maxRedirects: 0,
    });
  }

  /**
   * This process's own listener, not `API_BASE_URL`. The published URL can point
   * at another instance (or at nothing, in local development); the loop has to
   * land on the instance that holds this request's session and database.
   */
  private baseUrl(): string {
    const explicit = this.config.get<string>('MCP_SELF_API_URL');
    if (explicit) {
      let url = explicit.trim();
      while (url.endsWith('/')) url = url.slice(0, -1);
      return url;
    }
    const port = this.config.get<string>('PORT') ?? '3000';
    return `http://127.0.0.1:${port}/api/v1`;
  }

  for(credential: ForwardedCredential): McpApiCaller {
    const headers: Record<string, string> = {};
    if (credential.authorization) {
      headers.Authorization = credential.authorization;
    }
    if (credential.sessionCookie) {
      headers.Cookie = `${FLUI_SESSION_COOKIE}=${encodeURIComponent(
        credential.sessionCookie,
      )}`;
    }

    const send = async <T>(
      method: 'get' | 'post' | 'put' | 'patch' | 'delete',
      path: string,
      options: { query?: Record<string, unknown>; body?: unknown } = {},
    ): Promise<T> => {
      if (!hasCredential(credential)) {
        // No fallback to the in-process service: a tool that quietly stopped
        // going through the guards would be indistinguishable from one that
        // still did.
        throw new McpApiError(
          undefined,
          'This surface did not forward a credential, so the call cannot be made on the caller behalf.',
          method.toUpperCase(),
          path,
          'MCP_NO_FORWARDED_CREDENTIAL',
          'no credential',
        );
      }
      let res: AxiosResponse<unknown>;
      try {
        res = await this.http.request<unknown>({
          method,
          url: path,
          headers,
          params: options.query,
          data: options.body,
        });
      } catch (error) {
        const reason =
          error instanceof Error ? error.message : 'transport failure';
        throw new McpApiError(
          undefined,
          reason,
          method.toUpperCase(),
          path,
          undefined,
          reason,
        );
      }
      if (res.status >= 200 && res.status < 300) return res.data as T;
      throw new McpApiError(
        res.status,
        messageFrom(res.data, `HTTP ${res.status}`),
        method.toUpperCase(),
        path,
        codeFrom(res.data),
        undefined,
        readProposalRefusal(res.data),
      );
    };

    return {
      get: (path, query) => send('get', path, { query }),
      post: (path, body) => send('post', path, { body }),
      put: (path, body) => send('put', path, { body }),
      patch: (path, body) => send('patch', path, { body }),
      delete: (path) => send('delete', path),
    };
  }
}
