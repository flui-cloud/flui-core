apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: node-agent
  namespace: {{NAMESPACE}}
  labels:
    managed-by: flui-cloud
    component: velero
spec:
  selector:
    matchLabels:
      name: node-agent
  template:
    metadata:
      labels:
        name: node-agent
        component: velero
        managed-by: flui-cloud
    spec:
      serviceAccountName: velero
      hostPID: true
      containers:
        - name: node-agent
          image: {{VELERO_IMAGE}}
          imagePullPolicy: IfNotPresent
          command:
            - /velero
          args:
            - node-agent
            - server
          securityContext:
            privileged: true
            runAsUser: 0
          volumeMounts:
            - mountPath: /host_pods
              mountPropagation: HostToContainer
              name: host-pods
            - mountPath: /scratch
              name: scratch
            - mountPath: /credentials
              name: cloud-credentials
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: VELERO_NAMESPACE
              valueFrom:
                fieldRef:
                  fieldPath: metadata.namespace
            - name: VELERO_SCRATCH_DIR
              value: /scratch
            - name: AWS_SHARED_CREDENTIALS_FILE
              value: /credentials/cloud
            - name: VELERO_KOPIA_REPO_PASSWORD
              valueFrom:
                secretKeyRef:
                  name: {{SECRET_NAME}}
                  key: kopia-repo-password
          resources:
            requests:
              cpu: 100m
              memory: 128Mi
            limits:
              cpu: 500m
              memory: 1Gi
      volumes:
        - name: host-pods
          hostPath:
            path: /var/lib/kubelet/pods
        - name: scratch
          emptyDir: {}
        - name: cloud-credentials
          secret:
            secretName: {{SECRET_NAME}}
