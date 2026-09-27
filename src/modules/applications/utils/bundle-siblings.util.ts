import { In, IsNull, Repository } from 'typeorm';
import { ApplicationEntity } from '../entities/application.entity';
import { CatalogInstallEntity } from '../../catalog/entities/catalog-install.entity';

/**
 * The other components still alive in the catalog install this application
 * came from. A bundle is gone only when none is left.
 */
export async function liveBundleSiblings(
  applications: Repository<ApplicationEntity>,
  installs: Repository<CatalogInstallEntity>,
  app: Pick<ApplicationEntity, 'id' | 'metadata'>,
): Promise<{
  install: CatalogInstallEntity;
  siblings: ApplicationEntity[];
} | null> {
  const installId = app.metadata?.catalogInstallId as string | undefined;
  if (!installId) return null;
  const install = await installs.findOne({
    where: { id: installId, deletedAt: IsNull() },
  });
  if (!install) return null;
  const others = (install.applicationIds ?? []).filter((id) => id !== app.id);
  const siblings = others.length
    ? await applications.find({ where: { id: In(others) } })
    : [];
  return { install, siblings };
}
