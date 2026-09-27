import { ApplicationEntity } from '../../applications/entities/application.entity';

function envValue(app: ApplicationEntity, name: string): string | undefined {
  return app.env?.find((e) => e.name === name)?.value;
}

/**
 * The role and database the restored instance has to boot as.
 *
 * From the artifact first, because the source application is exactly what a
 * disaster restore does not have. `pgUser`/`pgDb` are read after it for
 * artifacts written before engines existed, when those were the only names
 * this summary carried; the live application is consulted last and only to
 * cover rows older still, which recorded neither.
 */
export function resolveRestoreIdentities(
  sourceApp: ApplicationEntity | null,
  summary: Record<string, any>,
  sourceAppId: string,
): { user: string; database: string } {
  const recorded = summary.identities as
    | { user?: string; database?: string }
    | undefined;
  const user =
    recorded?.user ??
    (summary.pgUser as string | undefined) ??
    (sourceApp ? envValue(sourceApp, 'POSTGRES_USER') : undefined) ??
    (sourceApp ? envValue(sourceApp, 'MARIADB_USER') : undefined) ??
    sourceAppId;
  const database =
    recorded?.database ??
    (summary.pgDb as string | undefined) ??
    (sourceApp ? envValue(sourceApp, 'POSTGRES_DB') : undefined) ??
    (sourceApp ? envValue(sourceApp, 'MARIADB_DATABASE') : undefined) ??
    user;
  return { user, database };
}
