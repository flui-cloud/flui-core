apiVersion: batch/v1
kind: Job
metadata:
  name: {{JOB_NAME}}
  namespace: {{NAMESPACE}}
  labels:
    managed-by: flui-cloud
    flui-job-id: "{{JOB_ID}}"
spec:
  backoffLimit: 2
  ttlSecondsAfterFinished: 86400
  template:
    metadata:
      labels:
        managed-by: flui-cloud
        flui-job-id: "{{JOB_ID}}"
    spec:
      restartPolicy: Never
      containers:
        - name: rclone
          image: {{RCLONE_IMAGE}}
          command:
            - rclone
            - --config=/etc/rclone/rclone.conf
            - copy
            - --checksum
            - --transfers=8
            - --checkers=16
            - src:{{SRC_BUCKET}}/{{SRC_PREFIX}}
            - dst:{{DST_BUCKET}}/{{DST_PREFIX}}
          volumeMounts:
            - name: config
              mountPath: /etc/rclone
              readOnly: true
          resources:
            requests:
              cpu: 200m
              memory: 256Mi
            limits:
              cpu: 1000m
              memory: 1Gi
      volumes:
        - name: config
          secret:
            secretName: {{SECRET_NAME}}
