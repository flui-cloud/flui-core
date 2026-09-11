export enum CloudProvider {
  CONTABO = 'contabo',
  HETZNER = 'hetzner',
  SCALEWAY = 'scaleway',
  /** OpenStack-based (Nova/Neutron via Keystone auth). No native firewall in practice (Neutron security-group quota is 0 on OVH), so firewalling falls back to host-nftables like BYOS. */
  OVH = 'ovh',
  /** Bring-your-own-server: install onto an operator-provisioned host over SSH; no provisioning API (node/firewall/networking are SSH/iptables-driven). */
  BYOS = 'byos',
}
