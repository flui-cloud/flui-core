import { CliAppService } from './services/cli-app.service';

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Resolve an application reference (name/slug or id) to its id. A UUID is used
 * as-is; a name/slug is looked up on `sourceClusterId` (app listing is
 * cluster-scoped, so the source cluster must be known first).
 */
export async function resolveApp(
  sourceClusterId: string,
  nameOrId: string,
): Promise<{ id: string; name: string }> {
  if (UUID_RE.test(nameOrId)) return { id: nameOrId, name: nameOrId };
  const svc = await CliAppService.create(sourceClusterId);
  const app = await svc.getAppByName(nameOrId);
  return { id: app.id, name: app.name };
}
