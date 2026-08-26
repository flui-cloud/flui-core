/**
 * The one sentence the showcase is introduced with, wherever it is shown.
 *
 * It lives in the API and not in the interface because three surfaces say it —
 * the dashboard, the CLI, and an agent holding the guest's own key — and a
 * sentence pasted into three of them is three sentences, free to drift until
 * one of them is describing a fence that no longer exists.
 *
 * Both halves are claims about code, not decoration, and each is pinned by a
 * test elsewhere: "read-only for you" is `showcase_viewer`, one permission,
 * `app:read` (`iam-showcase.ts`), and "everything else is yours alone" is the
 * tenancy's own namespace with the route fence around it.
 *
 * It is served as the `why` of the `showcase` area in `GET /sandbox/limits`,
 * beside every other statement of what a guest does and does not get, rather
 * than from a route of its own — see `sandbox-areas.ts`.
 */
export const SHOWCASE_BANNER =
  'A Flui project — read-only for you. Everything else you see in this instance is yours alone.';
