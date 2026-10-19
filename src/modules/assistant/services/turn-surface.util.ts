import { Logger } from '@nestjs/common';
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
export type SurfaceRejection =
  | { kind: 'schema'; detail: string }
  | { kind: 'revision'; detail: string }
  | { kind: 'semantics'; detail: string };

const logger = new Logger('TurnSurface');
const rejected: Record<SurfaceRejection['kind'], number> = {
  schema: 0,
  revision: 0,
  semantics: 0,
};

export function surfaceRejectionCounts(): Readonly<typeof rejected> {
  return { ...rejected };
}

/** Why a snapshot would be dropped, or null when it is accepted (or absent). */
export function surfaceRejection(
  surface: unknown,
  surfaceRevision?: number,
): { snapshot?: SurfaceSnapshot; rejection: SurfaceRejection | null } {
  if (surface === undefined || surface === null) return { rejection: null };
  const { snapshot, reason } = acceptSurface(surface);
  if (!snapshot) {
    return { rejection: { kind: 'schema', detail: reason ?? 'invalid' } };
  }
  if (
    surfaceRevision !== undefined &&
    surfaceRevision !== snapshot.surface.revision
  ) {
    return {
      rejection: {
        kind: 'revision',
        detail: `echo ${surfaceRevision} != snapshot ${snapshot.surface.revision}`,
      },
    };
  }
  const errors = validateSurfaceSemantics(snapshot).filter(
    (issue) => issue.severity === 'error',
  );
  if (errors.length) {
    return {
      rejection: {
        kind: 'semantics',
        detail: errors.map((e) => `${e.code} at ${e.path}`).join('; '),
      },
    };
  }
  return { snapshot, rejection: null };
}

export function acceptTurnSurface(
  surface: unknown,
  surfaceRevision?: number,
): SurfaceSnapshot | undefined {
  const { snapshot, rejection } = surfaceRejection(surface, surfaceRevision);
  if (rejection) {
    rejected[rejection.kind] += 1;
    logger.debug(
      `Surface dropped (${rejection.kind}): ${rejection.detail.slice(0, 300)}`,
    );
    return undefined;
  }
  return snapshot;
}
