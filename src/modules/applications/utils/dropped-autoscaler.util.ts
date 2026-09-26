import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';

/**
 * An autoscaler left behind after scaling is turned off keeps resizing the
 * workload. Named from the slug rather than from the last deploy's records, so
 * one already left behind by an earlier deploy is found too. Only this kind is
 * removed: anything else a deploy stops rendering may hold data.
 */
export function droppedAutoscaler(
  app: { slug: string; k8sNamespace: string },
  rendered: Array<{ kind: string }>,
): { kind: string; name: string; namespace: string } | null {
  const kind = ApplicationResourceKind.HORIZONTAL_POD_AUTOSCALER as string;
  if (rendered.some((m) => m.kind === kind)) return null;
  return { kind, name: `${app.slug}-hpa`, namespace: app.k8sNamespace };
}
