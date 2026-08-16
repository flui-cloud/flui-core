/**
 * A DaemonSet whose only job is to have already pulled the images the guided
 * path offers, on every node a guest can land on.
 *
 * This is what turns "about forty seconds" from a median into a promise. The
 * containers do nothing and exit; the kubelet keeps the layers. It is written as
 * initContainers precisely so the pod finishes and stops costing anything while
 * the images stay on disk.
 */
export function buildPrepullManifest(
  namespace: string,
  images: string[],
): string {
  const initContainers = images
    .map(
      (image, i) => `        - name: pull-${i}
          image: ${image}
          command: ["/bin/sh", "-c", "exit 0"]
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 50m
              memory: 64Mi`,
    )
    .join('\n');

  return `apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: sandbox-image-prepull
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: flui
    flui.cloud/sandbox: "true"
spec:
  selector:
    matchLabels:
      app: sandbox-image-prepull
  template:
    metadata:
      labels:
        app: sandbox-image-prepull
        flui.cloud/sandbox: "true"
    spec:
      # A warm cache is worth nothing if warming it evicts a guest's workload.
      priorityClassName: system-node-critical
      tolerations:
        - operator: Exists
      initContainers:
${initContainers}
      containers:
        - name: idle
          image: registry.k8s.io/pause:3.9
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 20m
              memory: 32Mi
`;
}
