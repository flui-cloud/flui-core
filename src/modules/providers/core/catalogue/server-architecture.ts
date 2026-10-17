import { Logger } from '@nestjs/common';
import { NodeSizeDto } from '../../dto/node-size.dto';

export type ServerArchitecture = 'x86' | 'arm';

const ARCHITECTURE_ALIASES: Record<string, ServerArchitecture> = {
  x86: 'x86',
  x86_64: 'x86',
  amd64: 'x86',
  arm: 'arm',
  arm64: 'arm',
  aarch64: 'arm',
};

export const ARM_SERVER_WARNING_CODE = 'ARM_SERVER';

export const ARM_SERVER_WARNING =
  'Arm server: apps deployed from a repository are built for x86 and will not run on it. Catalog apps run normally.';

/**
 * One vocabulary for a CPU architecture, whoever reported it: a provider's
 * catalogue (`x86`, `x86_64`, `arm64`), Kubernetes (`amd64`, `arm64`) or
 * `uname -m` on a host (`x86_64`, `aarch64`). Null when it is not one of them.
 */
export function normaliseArchitecture(
  raw: string | null | undefined,
): ServerArchitecture | null {
  if (!raw) return null;
  return ARCHITECTURE_ALIASES[raw.trim().toLowerCase()] ?? null;
}

/** The warning an architecture carries; null for x86 or one nothing names. */
export function architectureWarning(
  architecture: string | null | undefined,
): string | null {
  return normaliseArchitecture(architecture) === 'arm'
    ? ARM_SERVER_WARNING
    : null;
}

export function architectureOfType(
  serverType: string,
  sizes: Pick<NodeSizeDto, 'id' | 'name' | 'architecture'>[],
): ServerArchitecture | null {
  const size = sizes.find((s) => s.name === serverType || s.id === serverType);
  return normaliseArchitecture(size?.architecture);
}

export function serverTypeWarning(
  serverType: string,
  sizes: Pick<NodeSizeDto, 'id' | 'name' | 'architecture'>[],
): string | null {
  return architectureWarning(architectureOfType(serverType, sizes));
}

const logger = new Logger('ServerArchitecture');

/** Hetzner CAX and Scaleway COPARM/BASIC2-A, known by name when no catalogue answers. */
const KNOWN_ARM_FAMILIES = [/^cax\d/i, /^coparm\d/i, /^basic2-a\d/i];

/**
 * The warning a server type carries, reading the catalogue from the provider
 * that would sell it. Never refuses: an arm type is bought like any other.
 */
export async function providerServerTypeWarning(
  provider:
    | { getNodeSizes?(includeAvailability?: boolean): Promise<NodeSizeDto[]> }
    | null
    | undefined,
  serverType: string | null | undefined,
): Promise<string | null> {
  if (!serverType) return null;
  const byName = KNOWN_ARM_FAMILIES.some((family) => family.test(serverType))
    ? ARM_SERVER_WARNING
    : null;
  if (!provider?.getNodeSizes) return byName;
  try {
    const sizes = await provider.getNodeSizes(false);
    const architecture = architectureOfType(serverType, sizes);
    return architecture ? architectureWarning(architecture) : byName;
  } catch (err) {
    logger.log(
      `Could not read the provider catalogue (${err instanceof Error ? err.message : String(err)}); the architecture of ${serverType} is read from its name`,
    );
    return byName;
  }
}
