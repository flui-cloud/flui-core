import { ApplicationManifest } from '../interfaces/application-manifest.interface';
import { ApplicationScaling } from '../interfaces/source-config.interface';

/**
 * A range that cannot grow is a fixed replica count, not autoscaling. Any
 * target a person set on the app survives; the manifest owns only the range.
 * `min: 0` is read as 1: replica autoscaling cannot stop an app.
 */
export function scalingFromManifest(
  manifest: ApplicationManifest,
  current: ApplicationScaling | null | undefined,
): { scaling?: ApplicationScaling; replicas?: number } {
  const declared = manifest.deploy?.scaling;
  if (!declared) return {};
  const min = Math.max(1, declared.min ?? 1);
  const max = Math.max(min, declared.max ?? min);
  return {
    scaling: {
      ...current,
      enabled: max > min,
      minReplicas: min,
      maxReplicas: max,
    },
    replicas: min,
  };
}
