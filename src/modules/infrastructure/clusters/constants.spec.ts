import { RELEASE } from '../../../config/release.config';
import { K3S_DEFAULT_VERSION } from './constants';

describe('cluster constants', () => {
  it('installs the K3s version the release pins', () => {
    expect(K3S_DEFAULT_VERSION).toBe(RELEASE.k3s.version);
    expect(RELEASE.k3s.version).toMatch(/^v\d+\.\d+\.\d+\+k3s\d+$/);
  });
});
