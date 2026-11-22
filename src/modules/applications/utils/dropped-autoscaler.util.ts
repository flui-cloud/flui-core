import { ApplicationResourceKind } from '../enums/application-resource-kind.enum';

/**
 * Every autoscaler kind the deploy did not render. One left behind keeps
 * resizing the workload, and a CPU autoscaler next to a queue one would fight
 * it for the replicas. Named from the slug rather than from the last deploy's
 * records, so one left by an earlier deploy is found too. Only autoscalers are
 * removed: anything else a deploy stops rendering may hold data.
 */
export function droppedAutoscalers(
  app: { slug: string; k8sNamespace: string },
  rendered: Array<{ kind: string }>,
): Array<{ kind: string; name: string; namespace: string }> {
  const kinds: Array<[string, string]> = [
    [ApplicationResourceKind.HORIZONTAL_POD_AUTOSCALER, `${app.slug}-hpa`],
    [ApplicationResourceKind.SCALED_OBJECT, `${app.slug}-queue`],
  ];
  return kinds
    .filter(([kind]) => !rendered.some((m) => m.kind === kind))
    .map(([kind, name]) => ({ kind, name, namespace: app.k8sNamespace }));
}
