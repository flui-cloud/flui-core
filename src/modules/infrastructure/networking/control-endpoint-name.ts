import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { controlEndpointName } from './services/wireguard-peer-render';

export type ResolveAll = (name: string) => Promise<string[]>;

const resolveAll: ResolveAll = async (name) =>
  (await lookup(name, { all: true })).map((a) => a.address);

/**
 * Why the declared name members dial the primary by does not lead to the
 * master alone, or null when it does or none is declared. Only the primary is
 * dialled by name, so a name that also answers for another node sends members
 * to a peer whose key is not the one they expect there.
 */
export async function endpointNameProblem(
  primaryHost: string,
  env: NodeJS.ProcessEnv = process.env,
  resolve: ResolveAll = resolveAll,
): Promise<string | null> {
  const name = controlEndpointName(env);
  if (!name) return null;
  const consequence = 'members dial the control master by this name';
  try {
    const expected = new Set(
      isIP(primaryHost) ? [primaryHost] : await resolve(primaryHost),
    );
    const found = await resolve(name);
    if (found.length && found.every((a) => expected.has(a))) return null;
    return `FLUI_WG_ENDPOINT_NAME ${name} resolves to ${found.join(', ') || 'nothing'}, not to the control master (${primaryHost}) alone: ${consequence}`;
  } catch (error) {
    return `FLUI_WG_ENDPOINT_NAME ${name} does not resolve (${(error as Error).message}): ${consequence}`;
  }
}
