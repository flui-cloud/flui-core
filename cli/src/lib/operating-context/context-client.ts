import { ApiClient } from '../api-client';
import { ConfigStorage } from '../config-storage';
import type { ProbeCard } from '../../../../src/modules/operating-context/probes/probe-catalog';

export type { ProbeCard } from '../../../../src/modules/operating-context/probes/probe-catalog';

/**
 * The operating context, as a terminal reaches it.
 *
 * Everything goes over HTTP as the caller's own principal, so the covering
 * check inside the service is the one that decides what comes back — the CLI
 * asks the same questions the dashboard asks and is answered on the same terms.
 *
 * The shapes below are the notes **as they arrive on the wire**, which is not
 * the same thing as the service's own types: `updatedAt` is a `Date` in
 * `DeliveredEntry` and a string here, because that is what JSON carries.
 * Importing the server type would have been the tidier line and a false one.
 *
 * {@link ProbeCard} is the exception, and deliberately: it is imported and
 * never restated, because what a probe takes is a contract with one home. A
 * copy of it here is precisely the defect this whole route exists to remove.
 */
export interface ContextHand {
  name: string | null;
  isYou: boolean;
}

export interface ContextReach {
  audience: 'installation' | 'cluster' | 'selection';
  scopeType: string;
  scopeRef?: string | null;
  nature: string;
  descends: boolean;
  reachesGuests: boolean;
  sentence: string;
}

export interface ContextNote {
  id: string;
  scopeType: string;
  scopeRef?: string | null;
  nature: string;
  topic: string;
  title: string;
  body: string;
  confidence: 'checked' | 'stale' | 'broken' | 'unverified';
  checkedBy: 'none' | 'attestation' | 'probe';
  updatedAt: string;
  selector?: Record<string, unknown> | null;
  reaches?: ContextReach;
  writtenBy?: ContextHand | null;
  confirmedBy?: ContextHand | null;
  archivedBy?: ContextHand | null;
  archivedAt?: string | null;
}

/** What the caller is about to act on, if they said. */
export interface ContextFocus {
  slug?: string;
  clusterId?: string;
  clusterName?: string;
}

export class OperatingContextClient {
  constructor(private readonly api: ApiClient) {}

  static fromConfig(): OperatingContextClient {
    const cfg = new ConfigStorage();
    const apiKey = cfg.getApiKey();
    if (!apiKey) {
      throw new Error(
        'Not logged in. Run `flui auth login` first, or check the API key for this profile.',
      );
    }
    return new OperatingContextClient(
      new ApiClient({ baseUrl: cfg.getApiUrlOrThrow(), apiKey }),
    );
  }

  list(focus?: ContextFocus): Promise<ContextNote[]> {
    return this.api.get<ContextNote[]>(`/operating-context${query(focus)}`);
  }

  /** The notes that were retired, with the day and the hand that withdrew them. */
  archive(focus?: ContextFocus): Promise<ContextNote[]> {
    return this.api.get<ContextNote[]>(
      `/operating-context/archive${query(focus)}`,
    );
  }

  /** What a note may be made to lean on, and what each fact wants asked of it. */
  probes(): Promise<ProbeCard[]> {
    return this.api.get<ProbeCard[]>('/operating-context/probes');
  }

  /**
   * Who a note at this level would reach, **before** it is written.
   *
   * Asked rather than phrased locally. The line is a pure function of the level
   * and the nature and it is computed in one place on purpose, so that the
   * dashboard, this CLI and the sentence a person approves in the action cycle
   * cannot end up describing the same note three different ways.
   */
  reach(
    scopeType: string,
    nature: string,
    scopeRef?: string | null,
  ): Promise<ContextReach> {
    const params = new URLSearchParams({ scopeType, nature });
    if (scopeRef) params.set('scopeRef', scopeRef);
    return this.api.get<ContextReach>(
      `/operating-context/reach?${params.toString()}`,
    );
  }

  write(body: Record<string, unknown>): Promise<ContextNote> {
    return this.api.post<ContextNote>('/operating-context', body);
  }
}

function query(focus?: ContextFocus): string {
  if (!focus) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(focus)) {
    if (value) params.set(key, value);
  }
  const text = params.toString();
  return text ? `?${text}` : '';
}
