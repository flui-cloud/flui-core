import { FirewallRule } from '../../interfaces/firewall-provider.interface';
import { NftRenderOptions, renderFluiNftRuleset } from './nftables-ruleset';

/**
 * First-boot host firewall for providers whose firewall lives on the machine
 * itself. A node there has no protection until something applies a ruleset,
 * and the reconciler can only do that once the node answers SSH — by then k3s
 * has been listening for minutes. Baking the ruleset into the boot script
 * closes that window: nothing starts listening before it is in place.
 */
export function renderHostFirewallPreamble(
  rules: FirewallRule[],
  options: Omit<NftRenderOptions, 'supportsSshAllowlist'> = {},
): string {
  const sshPorts = options.sshPorts?.length ? options.sshPorts : [22];
  const ruleset = renderFluiNftRuleset(rules, {
    ...options,
    supportsSshAllowlist: false,
    sshPorts,
  });
  const b64 = Buffer.from(ruleset, 'utf-8').toString('base64');

  return `
# ── Flui host firewall — applied before k3s opens a port ────────────────────
echo "[Bootstrap] Applying host firewall..."
if ! command -v nft >/dev/null 2>&1; then
  DEBIAN_FRONTEND=noninteractive apt-get update -qq >/dev/null 2>&1 || true
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq nftables >/dev/null 2>&1 || true
fi
NFT=$(command -v nft || echo /usr/sbin/nft)
if [ ! -x "$NFT" ]; then
  echo "[Bootstrap] ERROR: nftables unavailable — refusing to start k3s on an unprotected host"
  exit 1
fi
mkdir -p /etc/flui
echo '${b64}' | base64 -d > /etc/flui/flui-firewall.nft
if ! "$NFT" -c -f /etc/flui/flui-firewall.nft; then
  echo "[Bootstrap] ERROR: the generated firewall ruleset is invalid"
  exit 1
fi
if ! "$NFT" -f /etc/flui/flui-firewall.nft; then
  echo "[Bootstrap] ERROR: could not apply the host firewall"
  exit 1
fi
cat > /etc/systemd/system/flui-firewall.service <<'FLUI_UNIT'
[Unit]
Description=Flui-managed host firewall (nftables)
After=network-pre.target
Wants=network-pre.target
[Service]
Type=oneshot
ExecStart=/usr/sbin/nft -f /etc/flui/flui-firewall.nft
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
FLUI_UNIT
systemctl daemon-reload 2>/dev/null || true
systemctl enable flui-firewall.service >/dev/null 2>&1 || true
echo "[Bootstrap] Host firewall active (SSH ${sshPorts.join(', ')}, HTTP 80, HTTPS 443)"
`;
}
