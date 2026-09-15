import { CliByosPurgeService } from './cli-byos-purge.service';

/**
 * The script this builds runs as root on somebody's machine and is the only
 * thing between "uninstalled" and "a host that cannot be installed on again".
 */
describe('the BYOS purge script', () => {
  const script = (removeAccess = false) =>
    new CliByosPurgeService({} as never).buildScript(removeAccess, null);

  it('takes the management tunnel down before removing its keys', () => {
    const s = script();
    expect(s).toContain('wg-quick down');
    expect(s).toContain('systemctl disable "wg-quick@$iface"');
    expect(s.indexOf('wg-quick down')).toBeLessThan(
      s.indexOf('rm -f /etc/wireguard/flui'),
    );
  });

  it('removes only Flui’s own WireGuard files', () => {
    // An operator may run tunnels of their own on the same host.
    const s = script();
    expect(s).toContain('/etc/wireguard/flui*.conf');
    expect(s).not.toContain('rm -rf /etc/wireguard');
  });

  it('clears the K3s node password', () => {
    // A fresh install mints a different one and k3s refuses it.
    expect(script()).toContain('/etc/rancher/node');
  });

  it('still uninstalls K3s and the firewall table', () => {
    const s = script();
    expect(s).toContain('k3s-uninstall.sh');
    expect(s).toContain('delete table inet flui');
  });

  it('never tears down SSH access unless asked', () => {
    expect(script(false)).not.toContain('authorized_keys');
  });
});
