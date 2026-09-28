import {
  declaresResource,
  documentsOf,
  requiredSecretsOf,
  statefulImageChangesAgainst,
  workloadImages,
  workloadsOf,
} from './manifest-documents.util';

const docs = documentsOf(`apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: postgres
  namespace: flui-system
spec:
  volumeClaimTemplates:
    - metadata:
        name: data
  template:
    spec:
      volumes:
        - name: tls
          secret:
            secretName: pg-tls
        - name: extra
          secret:
            secretName: pg-extra
            optional: true
      containers:
        - name: postgres
          image: postgres:16-alpine
          env:
            - name: PASSWORD
              valueFrom:
                secretKeyRef:
                  name: pg-auth
                  key: password
          envFrom:
            - secretRef:
                name: pg-env
---
apiVersion: apps/v1
kind: Deployment
metadata:
  name: redis
spec:
  template:
    spec:
      containers:
        - name: redis
          image: redis:8
---
apiVersion: v1
kind: ConfigMap
metadata:
  name: settings
`);

describe('the documents of a manifest file', () => {
  it('tells a file with resources from one without', () => {
    expect(declaresResource(docs)).toBe(true);
    expect(declaresResource(documentsOf('# nothing here\n'))).toBe(false);
  });

  it('lists the workloads, defaulting the namespace', () => {
    expect(workloadsOf(docs)).toEqual([
      { kind: 'StatefulSet', name: 'postgres', namespace: 'flui-system' },
      { kind: 'Deployment', name: 'redis', namespace: 'default' },
    ]);
  });

  it('maps every workload container to its image', () => {
    expect([...workloadImages(docs)]).toEqual([
      ['StatefulSet/postgres/postgres', 'postgres:16-alpine'],
      ['Deployment/redis/redis', 'redis:8'],
    ]);
  });

  it('lists the Secrets a pod cannot start without, leaving optional ones out', () => {
    expect(requiredSecretsOf(docs)).toEqual([
      'flui-system/pg-auth',
      'flui-system/pg-env',
      'flui-system/pg-tls',
    ]);
  });

  it('compares a stateful workload against the images a cluster runs', () => {
    const running = new Map([
      ['StatefulSet/postgres/postgres', 'postgres:15-alpine'],
      ['Deployment/redis/redis', 'redis:7'],
    ]);
    expect(statefulImageChangesAgainst(running, docs)).toEqual([
      {
        workload: 'StatefulSet/postgres/postgres',
        from: 'postgres:15-alpine',
        to: 'postgres:16-alpine',
      },
    ]);
  });
});
