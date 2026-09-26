jest.mock('@kubernetes/client-node', () => ({}));

import { KubernetesService } from './kubernetes.service';

describe('CPU quantities', () => {
  const k8s = Object.create(KubernetesService.prototype) as KubernetesService;

  it('reads millicores, whole cores, and the nano and micro cores usage is reported in', () => {
    expect(k8s.parseCpu('250m')).toBe(250);
    expect(k8s.parseCpu('1.5')).toBe(1500);
    expect(k8s.parseCpu('318747829n')).toBe(319);
    expect(k8s.parseCpu('12000u')).toBe(12);
  });
});
