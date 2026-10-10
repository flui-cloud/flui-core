import { planApiSizing, systemReplicasRefusal } from './platform-api-sizing';

const live = {
  replicas: 1,
  requests: { cpu: '250m', memory: '512Mi' },
  limits: { cpu: '1', memory: '1Gi' },
};

describe('planApiSizing', () => {
  it('changes nothing when the chosen values only differ in how they are written', () => {
    expect(
      planApiSizing(
        {
          replicas: 1,
          resources: {
            cpu: { request: '0.25', limit: '1000m' },
            memory: { request: '512Mi', limit: '1024Mi' },
          },
        },
        live,
        6,
      ),
    ).toEqual({ replicas: null, resources: null, refused: null });
  });

  it('leaves the template resources alone when the installation chose none', () => {
    expect(planApiSizing({ replicas: 3, resources: {} }, live, 6)).toEqual({
      replicas: 3,
      resources: null,
      refused: null,
    });
  });

  it('patches only the resources that differ', () => {
    expect(
      planApiSizing(
        {
          replicas: 1,
          resources: { memory: { limit: '2Gi' }, cpu: { request: '250m' } },
        },
        live,
        6,
      ).resources,
    ).toEqual({ limits: { memory: '2Gi' } });
  });

  it('never takes the API down to no copies, nor past the allowed maximum', () => {
    expect(planApiSizing({ replicas: 0 }, live, 6)).toMatchObject({
      replicas: null,
      resources: null,
    });
    expect(planApiSizing({ replicas: 0 }, live, 6).refused).toBeTruthy();
    expect(planApiSizing({ replicas: 7 }, live, 6).refused).toContain(
      'FLUI_API_MAX_REPLICAS',
    );
  });
});

describe('planApiSizing with the autoscaler on', () => {
  it('leaves the copies to the autoscaler and still puts back the resources', () => {
    expect(
      planApiSizing(
        {
          replicas: 1,
          autoscaled: true,
          resources: { memory: { limit: '2Gi' } },
        },
        { ...live, replicas: 4 },
        6,
      ),
    ).toEqual({
      replicas: null,
      resources: { limits: { memory: '2Gi' } },
      refused: null,
    });
  });
});

describe('systemReplicasRefusal', () => {
  const api = {
    slug: 'flui-api',
    k8sNamespace: 'flui-system',
    systemProtected: true,
  };

  it('refuses to stop a platform application', () => {
    expect(systemReplicasRefusal(api, 0)).toBeTruthy();
    expect(
      systemReplicasRefusal(
        {
          slug: 'flui-web',
          k8sNamespace: 'flui-system',
          systemProtected: true,
        },
        0,
      ),
    ).toBeTruthy();
  });

  it('caps the API copies and lets ordinary applications stop', () => {
    expect(systemReplicasRefusal(api, 7)).toContain('FLUI_API_MAX_REPLICAS');
    expect(systemReplicasRefusal(api, 3)).toBeNull();
    expect(
      systemReplicasRefusal(
        { slug: 'shop', k8sNamespace: 'p-1', systemProtected: false },
        0,
      ),
    ).toBeNull();
  });
});
