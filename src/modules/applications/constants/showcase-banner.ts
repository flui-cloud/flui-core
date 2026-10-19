/**
 * The one sentence the showcase is introduced with, wherever it is shown.
 *
 * It lives in the API and not in the interface because three surfaces say it —
 * the dashboard, the CLI, and an agent holding the guest's own key — and a
 * sentence pasted into three of them is three sentences, free to drift until
 * one of them is describing a fence that no longer exists.
 *
 * It is a claim about code, pinned by a test elsewhere: "read-only for you" is
 * `showcase_viewer`, one permission, `app:read` (`iam-showcase.ts`). It says
 * nothing about a space of one's own, because a visitor and a guest without an
 * area have none: for them the whole demo is read-only, and the dashboard says
 * so in its own sentence for read-only viewers.
 *
 * It is served as the `why` of the `showcase` area in `GET /sandbox/limits`,
 * beside every other statement of what a guest does and does not get, rather
 * than from a route of its own — see `sandbox-areas.ts`.
 */
export const SHOWCASE_BANNER =
  'A Flui project to look around, read-only for you.';
