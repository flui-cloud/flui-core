import { AppVariablesView } from './services/cli-app.service';

export type VariableState = 'plain' | 'set' | 'missing';

export interface VariableRow {
  key: string;
  state: VariableState;
  /** Exactly what may be printed. For a sensitive key this is never a value. */
  shown: string;
}

/** What a configured sensitive key looks like on screen. A constant, not data. */
const SET = '•••••••• (set)';
const MISSING = 'awaiting a value';

/**
 * Turn the API's variables view into printable rows.
 *
 * Two properties this function exists to guarantee, both of them tested:
 *
 *  - **a sensitive key never renders a value.** `shown` for a configured
 *    secret is a fixed string, not `data[key]`. The API masks already; this
 *    makes the CLI incapable of printing a value even if one ever arrived,
 *    rather than merely unlikely to;
 *  - **missing is a state.** A key awaiting a person is listed alongside the
 *    others with its own label. It is not an omission, not a blank, and not an
 *    error — the caller exits 0 either way.
 */
export function describeVariables(view: AppVariablesView): VariableRow[] {
  const sensitive = new Set(view.sensitiveKeys ?? []);
  const pending = new Set(view.pendingKeys ?? []);
  const rows: VariableRow[] = [];

  for (const [key, value] of Object.entries(view.data ?? {})) {
    if (pending.has(key)) continue;
    rows.push(
      sensitive.has(key)
        ? { key, state: 'set', shown: SET }
        : { key, state: 'plain', shown: value },
    );
  }

  // A configured sensitive key the read reported without putting in `data`
  // still belongs on screen: the two lists answer different questions and only
  // `sensitiveKeys` is authoritative about which secrets exist.
  for (const key of sensitive) {
    if (pending.has(key)) continue;
    if (rows.some((row) => row.key === key)) continue;
    rows.push({ key, state: 'set', shown: SET });
  }

  for (const key of pending) {
    rows.push({ key, state: 'missing', shown: MISSING });
  }

  return rows.sort((a, b) => a.key.localeCompare(b.key));
}
