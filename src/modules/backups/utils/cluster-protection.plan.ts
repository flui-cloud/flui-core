import { ApplicationKind } from '../../applications/enums/application-kind.enum';
import { ApplicationCategory } from '../../applications/enums/application-category.enum';

export const DB_ENGINE_LABEL = 'flui.cloud/db-engine';

export interface PlannableApp {
  kind: ApplicationKind | string;
  category: ApplicationCategory | string;
  systemProtected?: boolean | null;
  volumes?: unknown[] | null;
  labels?: Record<string, string> | null;
}

/** What already protects the application, from the policies on its cluster. */
export interface ExistingCover {
  database: boolean;
  volumeCopy: boolean;
}

export interface EngineSupport {
  /** A database engine Flui backs up with its own tool (continuous, or dumps). */
  database(engine: string): boolean;
  /** An engine whose volume Flui can copy consistently while it runs. */
  consistentCopy(engine: string): boolean;
}

export type AppProtectionPlan =
  | { kind: 'database'; engine: string }
  | { kind: 'volume_copy'; engine?: string }
  | { kind: 'needs_decision'; reason: string; engine?: string }
  | { kind: 'already_protected' }
  | { kind: 'skip'; reason: 'system' | 'no_data' };

export function declaredEngineOf(app: PlannableApp): string | undefined {
  const engine = app.labels?.[DB_ENGINE_LABEL]?.trim();
  return engine || undefined;
}

/**
 * Which backup one application gets when its cluster is protected.
 *
 * A database Flui recognises gets its own engine; anything else holding data
 * gets kopia copies of its volumes, which decide volume by volume on every run
 * (SQLite online backup, engine hooks, refusal of a live data directory). What
 * looks like a database Flui cannot copy consistently is not given a policy that
 * would fail every night: it is left for a person to decide.
 */
export function planAppProtection(
  app: PlannableApp,
  cover: ExistingCover,
  support: EngineSupport,
): AppProtectionPlan {
  if (
    app.systemProtected ||
    app.category === ApplicationCategory.SYSTEM ||
    app.kind === ApplicationKind.SYSTEM
  ) {
    return { kind: 'skip', reason: 'system' };
  }
  if (cover.database || cover.volumeCopy) return { kind: 'already_protected' };

  const engine = declaredEngineOf(app);
  const hasVolumes = (app.volumes?.length ?? 0) > 0;

  if (engine && support.database(engine)) return { kind: 'database', engine };
  if (!hasVolumes) return { kind: 'skip', reason: 'no_data' };
  if (engine && support.consistentCopy(engine)) {
    return { kind: 'volume_copy', engine };
  }
  if (engine) {
    return {
      kind: 'needs_decision',
      engine,
      reason: `${engine} has no consistent backup in Flui yet: copy it with the application stopped, or leave it out`,
    };
  }
  if (app.kind === ApplicationKind.DATABASE) {
    return {
      kind: 'needs_decision',
      reason:
        'it is a database that does not say which engine it runs, so no consistent backup can be chosen for it',
    };
  }
  return { kind: 'volume_copy' };
}
