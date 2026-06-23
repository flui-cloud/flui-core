export enum CloudProvider {
  CONTABO = 'contabo',
  HETZNER = 'hetzner',
  SCALEWAY = 'scaleway',
  /** Bring-your-own-server: install onto an operator-provisioned host over SSH; no provisioning API (node/firewall/networking are SSH/iptables-driven). */
  BYOS = 'byos',
}
