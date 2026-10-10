import { registryRepositoryFor } from './flui-registry.config';

/** Where a build of this application pushes, on the instance's own registry. */
export function fluiImageName(host: string, applicationId: string): string {
  return `${host}/${registryRepositoryFor(applicationId)}`;
}

/** Whether an image reference lives on the instance's own registry. */
export function isFluiImageRef(
  imageRef: string | null | undefined,
  host: string | null,
): boolean {
  return !!imageRef && !!host && imageRef.startsWith(`${host}/`);
}

/** Whether an image reference is this application's own, and no one else's. */
export function isOwnFluiImageRef(
  imageRef: string | null | undefined,
  host: string,
  applicationId: string,
): boolean {
  const name = fluiImageName(host, applicationId);
  return (
    !!imageRef &&
    (imageRef.startsWith(`${name}:`) || imageRef.startsWith(`${name}@`))
  );
}

/**
 * The repository secrets one application's build logs in with. Per
 * application, because one repository can hold several: slugs are lowercase
 * letters, digits and dashes, so this mapping cannot make two of them collide.
 */
export function registrySecretNames(slug: string): {
  username: string;
  password: string;
} {
  const suffix = slug.toUpperCase().replaceAll('-', '_');
  return {
    username: `FLUI_REGISTRY_USER_${suffix}`,
    password: `FLUI_REGISTRY_TOKEN_${suffix}`,
  };
}
