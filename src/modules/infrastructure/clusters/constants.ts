import { RELEASE } from '../../../config/release.config';

export const K3S_DEFAULT_VERSION = RELEASE.k3s.version;

/** Namespace for the control cluster's observability stack on new installs. */
export const FLUI_CONTROL_NAMESPACE = 'flui-control';

/** Legacy namespace used by control clusters provisioned before the control-cluster rename. */
export const FLUI_LEGACY_CONTROL_NAMESPACE = 'flui-observability';
