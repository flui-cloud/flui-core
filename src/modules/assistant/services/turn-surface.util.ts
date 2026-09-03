import {
  acceptSurface,
  SurfaceSnapshot,
  validateSurfaceSemantics,
} from '@flui-cloud/semantic-surface';

/**
 * The receiving half of spec §11.1: a Semantic Surface snapshot travels as an
 * optional field of the chat-turn request and MUST be discarded silently when
 * it fails validation, never turned into a 400 that fails the user's actual
 * message. Called once, as early as the turn is assembled, so nothing further
 * down the loop ever sees a snapshot that hasn't cleared both checks.
 *
 * Two levels, per §12.3: `acceptSurface` is the schema (size + shape); a
 * snapshot that passes it still goes through `validateSurfaceSemantics` for
 * what a JSON Schema cannot see — broken scope references, a revision that
 * does not advance, an invented timestamp. Only `error`-severity issues drop
 * it; a `warning` is left for the render step to live with, same as the
 * producer side treats its own semantic pass.
 *
 * `surfaceRevision` is the echo the client sends beside the snapshot that
 * already carries its own `surface.revision` (§7.2, mirroring vops's own
 * `agent-ask.controller.ts`): the two must agree, or the client's own state
 * is already muddled and neither half can be trusted.
 */
export function acceptTurnSurface(
  surface: unknown,
  surfaceRevision?: number,
): SurfaceSnapshot | undefined {
  const { snapshot } = acceptSurface(surface);
  if (!snapshot) return undefined;
  if (
    surfaceRevision !== undefined &&
    surfaceRevision !== snapshot.surface.revision
  ) {
    return undefined;
  }
  const issues = validateSurfaceSemantics(snapshot);
  if (issues.some((issue) => issue.severity === 'error')) return undefined;
  return snapshot;
}
