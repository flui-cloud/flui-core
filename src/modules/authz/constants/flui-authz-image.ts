import { RELEASE } from '../../../config/release.config';

/**
 * FLUI_AUTHZ_IMAGE_TAG is injected into the API env by the control-cluster
 * bootstrap, pinned to the install's release; the release pin is the fallback.
 */
export function fluiAuthzImage(): string {
  return `ghcr.io/flui-cloud/flui-authz:${process.env.FLUI_AUTHZ_IMAGE_TAG ?? RELEASE.images.fluiAuthz}`;
}
