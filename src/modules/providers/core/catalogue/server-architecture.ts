import { BadRequestException, Logger } from '@nestjs/common';
import { NodeSizeDto } from '../../dto/node-size.dto';

export type ServerArchitecture = 'x86' | 'arm';

export const SUPPORTED_ARCHITECTURE: ServerArchitecture = 'x86';

const ARCHITECTURE_ALIASES: Record<string, ServerArchitecture> = {
  x86: 'x86',
  x86_64: 'x86',
  amd64: 'x86',
  arm: 'arm',
  arm64: 'arm',
  aarch64: 'arm',
};

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

export function isSupportedArchitecture(
  architecture: string | null | undefined,
): boolean {
  return normaliseArchitecture(architecture) === SUPPORTED_ARCHITECTURE;
}

/** The server types Flui offers for a new or resized node. */
export function offerableSizes<T extends Pick<NodeSizeDto, 'architecture'>>(
  sizes: T[],
): T[] {
  return sizes.filter((size) => isSupportedArchitecture(size.architecture));
}

export function unsupportedArchitectureMessage(
  serverType: string,
  architecture: string,
): string {
  return `Flui runs on x86 servers only for now; ${serverType} is ${architecture}`;
}

export function architectureOfType(
  serverType: string,
  sizes: Pick<NodeSizeDto, 'id' | 'name' | 'architecture'>[],
): ServerArchitecture | null {
  const size = sizes.find((s) => s.name === serverType || s.id === serverType);
  return normaliseArchitecture(size?.architecture);
}

/**
 * Refuses a server type the catalogue says is not x86. A type the catalogue
 * does not name passes: whether it exists is a different question, answered
 * where it is asked.
 */
export function assertSupportedServerType(
  serverType: string,
  sizes: Pick<NodeSizeDto, 'id' | 'name' | 'architecture'>[],
): void {
  const architecture = architectureOfType(serverType, sizes);
  if (architecture && architecture !== SUPPORTED_ARCHITECTURE) {
    throw new BadRequestException(
      unsupportedArchitectureMessage(serverType, architecture),
    );
  }
}

const logger = new Logger('ServerArchitecture');

/** Hetzner CAX and Scaleway COPARM, refused by name when no catalogue answers. */
const KNOWN_ARM_FAMILIES = [/^cax\d/i, /^coparm\d/i, /^basic2-a\d/i];

/** The same check, reading the catalogue from the provider that would sell it. */
export async function assertProviderSellsSupportedType(
  provider:
    | { getNodeSizes?(includeAvailability?: boolean): Promise<NodeSizeDto[]> }
    | null
    | undefined,
  serverType: string,
): Promise<void> {
  if (!provider?.getNodeSizes || !serverType) return;
  let sizes: NodeSizeDto[];
  try {
    sizes = await provider.getNodeSizes(false);
  } catch (err) {
    if (KNOWN_ARM_FAMILIES.some((family) => family.test(serverType))) {
      throw new BadRequestException(
        unsupportedArchitectureMessage(serverType, 'arm'),
      );
    }
    logger.warn(
      `Could not read the provider catalogue (${err instanceof Error ? err.message : String(err)}); ${serverType} passes without an architecture check`,
    );
    return;
  }
  assertSupportedServerType(serverType, sizes);
}
