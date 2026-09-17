import { NftRenderOptions } from './nftables-ruleset';
import { WG_INTERFACE } from '../../../infrastructure/networking/wireguard-config';
import { observabilityIngestPorts } from '../../../infrastructure/networking/observability-ingest';

const API_SERVER_PORT = 6443;

/**
 * What the host ruleset trusts the overlay interface to carry.
 *
 * Kept apart from the renderer because it is policy, not rendering: the renderer
 * is told which ports to trust, and this is where that decision is made. Shared
 * by everything that needs to know it, so there is one answer rather than
 * several that agree until they do not.
 */
export function overlayRulesetOptions(): Pick<
  NftRenderOptions,
  'wgInterface' | 'wgOnlyPorts'
> {
  return {
    wgInterface: WG_INTERFACE,
    wgOnlyPorts: [
      { port: API_SERVER_PORT, protocol: 'tcp' as const },
      ...observabilityIngestPorts().ports.map((port) => ({
        port,
        protocol: 'tcp' as const,
      })),
    ],
  };
}
