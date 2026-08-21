import { CatalogImageSource } from '../interfaces/catalog-manifest.interface';

/**
 * The one place that turns a manifest's image into the string a node pulls.
 *
 * It has to be one place: whatever warms an image on a node and whatever runs
 * it must agree down to the character, or the cache is warm for a name nothing
 * asks for.
 */
export function buildImageRef(image: CatalogImageSource): string {
  if (image.source) {
    throw new Error('Build-from-git images are not supported in Iteration 1');
  }
  const registry = image.registry ?? 'docker.io';
  const repository = image.repository ?? '';
  const tag = image.tag ?? 'latest';
  if (!repository) {
    throw new Error('image.repository is required');
  }
  const prefix = registry === 'docker.io' ? '' : `${registry}/`;
  return `${prefix}${repository}:${tag}`;
}
