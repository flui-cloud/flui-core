const API_VERSION_BY_KIND: Record<string, string> = {
  Pod: 'v1',
  Service: 'v1',
  ConfigMap: 'v1',
  Secret: 'v1',
  PersistentVolumeClaim: 'v1',
  Namespace: 'v1',
  Deployment: 'apps/v1',
  StatefulSet: 'apps/v1',
  DaemonSet: 'apps/v1',
  // Without this the map's `v1` default would send a ReplicaSet lookup to
  // the core API, which has no such kind. It is read when walking a pod
  // back to the Deployment that owns it.
  ReplicaSet: 'apps/v1',
  Job: 'batch/v1',
  CronJob: 'batch/v1',
  HorizontalPodAutoscaler: 'autoscaling/v2',
  Ingress: 'networking.k8s.io/v1',
  IngressRoute: 'traefik.containo.us/v1alpha1',
  Middleware: 'traefik.io/v1alpha1',
  Certificate: 'cert-manager.io/v1',
  CertificateRequest: 'cert-manager.io/v1',
  ClusterIssuer: 'cert-manager.io/v1',
  Issuer: 'cert-manager.io/v1',
  Challenge: 'acme.cert-manager.io/v1',
  Order: 'acme.cert-manager.io/v1',
  ServiceAccount: 'v1',
  ClusterRole: 'rbac.authorization.k8s.io/v1',
  ClusterRoleBinding: 'rbac.authorization.k8s.io/v1',
  MutatingWebhookConfiguration: 'admissionregistration.k8s.io/v1',
  ValidatingWebhookConfiguration: 'admissionregistration.k8s.io/v1',
  Role: 'rbac.authorization.k8s.io/v1',
  RoleBinding: 'rbac.authorization.k8s.io/v1',
  APIService: 'apiregistration.k8s.io/v1',
  Backup: 'velero.io/v1',
  Restore: 'velero.io/v1',
  BackupStorageLocation: 'velero.io/v1',
  VolumeSnapshotLocation: 'velero.io/v1',
  Schedule: 'velero.io/v1',
  PodVolumeBackup: 'velero.io/v1',
  PodVolumeRestore: 'velero.io/v1',
};

export function apiVersionForKind(kind: string): string {
  return API_VERSION_BY_KIND[kind] || 'v1';
}
