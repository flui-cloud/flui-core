import {
  ScopedCredential,
  credentialCeiling,
} from '../../auth/utils/credential-ceiling.util';
import {
  ACTION_PROPOSAL_CODE,
  ACTION_PROPOSAL_DENIED_CODE,
} from '../../action-cycle/action-cycle.core';
import { ActivityReach } from './agent-activity.reach';

/**
 * What kind of thing the `error` column is describing, read off the two columns
 * beside it rather than off its text.
 *
 * The columns are Flui's own and cannot be wrong; the text is a string built
 * somewhere downstream and can be anything at all. Classifying on the columns is
 * therefore stable across every rewording of every message in the product.
 */
export type RegisterErrorKind = 'waiting' | 'refused' | 'failed';

/**
 * Stored values that are, in their entirety, words written in Flui's own source
 * with nothing interpolated into them.
 *
 * Same invariant as {@link redactToolArgs}, restated for a different column:
 * **everything that leaves here verbatim is a member of a set written in Flui's
 * own source.** The first two are literals at the two scope refusals in
 * `mcp-tool.util.ts`. They are duplicated rather than imported because that file
 * spells them inline, and the duplication is safe in the only direction that
 * matters: if the wording there changes, the match fails and this withholds
 * more, never less.
 *
 * The other two are the action cycle's own codes, imported rather than copied
 * because they already are constants — and a code is the whole reason the door
 * writes one instead of the sentence beside it. That sentence is addressed to a
 * model, is assembled by concatenation and gets reworded; the code is Flui's
 * own vocabulary and says the same thing to every reader, so it crosses this
 * boundary without widening it by a single character.
 */
const OWN_WORDS: ReadonlySet<string> = new Set([
  'missing scope',
  'destructive disabled',
  ACTION_PROPOSAL_CODE,
  ACTION_PROPOSAL_DENIED_CODE,
]);

/**
 * What a reader below the boundary is told instead of the stored text.
 *
 * Not `null`: an empty `error` beside `allowed: false` reads as "no reason
 * recorded", which is a claim about the register rather than about this reader.
 * The register says why it is not showing the text.
 */
const WITHHELD: Record<RegisterErrorKind, string> = {
  waiting:
    'Waiting on a person. What was asked for is on the request itself — open it there, not here.',
  refused:
    'Refused. The refusal text is withheld from this view: it is composed downstream and can carry whatever the component that refused put in it.',
  failed:
    'Failed. The failure text is withheld from this view: it is composed downstream and can carry whatever the component that failed put in it.',
};

/** The disclosed `error`, and whether it is the stored one. */
export interface ErrorDisclosure {
  text: string | null;
  withheld: boolean;
}

/** The three columns the classification is made of. */
export interface RegisterErrorRow {
  error: string | null;
  allowed: boolean;
  outcome: string | null;
}

export function registerErrorKind(row: RegisterErrorRow): RegisterErrorKind {
  if (row.outcome === 'input_required') return 'waiting';
  return row.allowed ? 'failed' : 'refused';
}

/**
 * Who reads the stored text as it was stored.
 *
 * Two conditions, and the second is the one that is easy to miss:
 *
 *  - **instance reach**, i.e. `iam:read-access` — whoever administers who may
 *    reach what is also who is answerable for a failure, and the full text is
 *    the only copy there is;
 *  - **and no `mcp:*` ceiling.** An agent credential minted for `mcp:iam:read`
 *    passes the reach test — it carries `iam:read-access` by design — and would
 *    otherwise page the whole instance's failure texts straight into a model's
 *    context. A ceiling means the credential is not the whole person, and this
 *    is one of the things it is not.
 */
export function readsErrorsVerbatim(
  reach: ActivityReach,
  credential: ScopedCredential | undefined,
): boolean {
  return reach === 'instance' && credentialCeiling(credential) === null;
}

/**
 * The `error` column, disclosed at the boundary that needs one.
 *
 * The leak this closes is the same class as the credential one found earlier in
 * this series, and it is not hypothetical: `describeError` returns
 * `error.message` untouched, and messages in this product are built by
 * concatenation — `native-ssh-connection.service.ts` writes
 * `SSH exec failed (code n): ${stderr}`, and `describeAxiosBody` will
 * `JSON.stringify` a whole provider response body when it recognises no message
 * field. Any of that can reach `mcp_tool_call_logs.error`, and until now every
 * reader of `/agent/activity` got it back verbatim — **a sandbox guest
 * included**, on rows produced by tools running against shared infrastructure.
 *
 * **The boundary is on the read, deliberately not on the write.** Redacting
 * before storing would be simpler and is wrong: the row is the only copy, so
 * cutting it at the write takes the diagnosis away from the person who is
 * answerable for it as well. Stored whole, disclosed narrowly — the same shape
 * the operation join already has two methods down.
 *
 * Fail-closed everywhere: an unrecognised message is withheld, and the
 * classification that chooses *which* withholding sentence comes off the
 * `allowed` and `outcome` columns, never off the text being withheld.
 */
export function discloseRegisterError(
  row: RegisterErrorRow,
  verbatim: boolean,
): ErrorDisclosure {
  if (!row.error) return { text: null, withheld: false };
  if (verbatim || OWN_WORDS.has(row.error)) {
    return { text: row.error, withheld: false };
  }
  return { text: WITHHELD[registerErrorKind(row)], withheld: true };
}
