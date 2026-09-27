jest.mock('@kubernetes/client-node', () => ({}));

import { proxyThrough } from './cli-ssh.service';

describe('reaching a workload node through the control', () => {
  it('crosses the control as the jump user, with the same key and certificate, forwarding only', () => {
    const proxy = proxyThrough(
      { host: '49.13.132.151', user: 'flui-jump', port: 22 },
      '/tmp/k',
      '/tmp/k-cert.pub',
    );
    expect(proxy).toBe(
      'ProxyCommand=ssh -i /tmp/k -o CertificateFile=/tmp/k-cert.pub -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o PasswordAuthentication=no -p 22 -W %h:%p flui-jump@49.13.132.151',
    );
  });
});
