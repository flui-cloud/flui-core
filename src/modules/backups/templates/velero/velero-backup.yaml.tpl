apiVersion: velero.io/v1
kind: Backup
metadata:
  name: {{BACKUP_NAME}}
  namespace: {{NAMESPACE}}
  labels:
    managed-by: flui-cloud
    flui-policy-id: "{{POLICY_ID}}"
    flui-job-id: "{{JOB_ID}}"
{{EXTRA_LABELS_BLOCK}}
spec:
  storageLocation: {{BSL_NAME}}
  defaultVolumesToFsBackup: {{INCLUDE_PVCS}}
  resourcePolicy:
    kind: configmap
    name: {{VOLUME_POLICY_NAME}}
  ttl: {{TTL}}
  includedNamespaces:
{{INCLUDED_NAMESPACES_BLOCK}}
{{LABEL_SELECTOR_BLOCK}}
