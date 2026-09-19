jest.mock('@kubernetes/client-node', () => ({}));

import { K3sScriptService } from './k3s-script.service';

const resolve = (localStorage?: {
  device?: string;
  sizeGb?: number;
}): { device: string; sizeGb: number } =>
  (
    new K3sScriptService() as never as {
      resolveLocalStorage: (l?: { device?: string; sizeGb?: number }) => {
        device: string;
        sizeGb: number;
      };
    }
  ).resolveLocalStorage(localStorage);

describe('the node-local storage a bootstrap script builds', () => {
  /**
   * Nine call sites build a bootstrap script. A ceiling that each of them has
   * to remember to ask for is not a ceiling: the one that forgets produces a
   * node where a single workload can fill `/` and take k3s down with it. So the
   * default lives here, where no caller can omit it.
   */
  it('asks for a filesystem of its own even when the caller says nothing', () => {
    expect(resolve()).toEqual({ device: '', sizeGb: 20 });
    expect(resolve({})).toEqual({ device: '', sizeGb: 20 });
  });

  it('honours a size the caller does choose', () => {
    expect(resolve({ sizeGb: 50 })).toEqual({ device: '', sizeGb: 50 });
  });

  /** The older shape — a plain directory, no quota — is still reachable. */
  it('lets a caller opt out with zero', () => {
    expect(resolve({ sizeGb: 0 })).toEqual({ device: '', sizeGb: 0 });
  });

  /**
   * Asking for both would have the script quietly prefer one, and the operator
   * would have no way to tell which from the outside.
   */
  it('drops the backing file when a device of its own is given', () => {
    expect(resolve({ device: '/dev/sdb', sizeGb: 50 })).toEqual({
      device: '/dev/sdb',
      sizeGb: 0,
    });
  });
});
