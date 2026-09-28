jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('ip-cidr', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('libsodium-wrappers', () => ({ ready: Promise.resolve() }));

import { readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { GUARDS_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { DATA_DOOR_KEY } from './decorators/data-door.decorator';
import { REQUIRED_PERMISSION_KEY } from './decorators/require-permission.decorator';
import { REQUIRED_SECTION_KEY } from './decorators/require-section.decorator';

/**
 * The guards read the handler and the controller class only; a gate on any
 * other class is inert.
 */
const GATE_KEYS = [
  REQUIRED_SECTION_KEY,
  REQUIRED_PERMISSION_KEY,
  DATA_DOOR_KEY,
  GUARDS_METADATA,
];

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

describe('gate decorators sit on controllers', () => {
  const src = join(__dirname, '..', '..');
  const files = controllerFiles(join(src, 'modules'));

  it('scans the controllers, so the check is not silently empty', () => {
    expect(files.length).toBeGreaterThan(50);
  });

  it('no exported class other than a controller carries a gate', () => {
    const misplaced: string[] = [];
    for (const file of files) {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const mod = require(file) as Record<string, unknown>;
      for (const [name, exported] of Object.entries(mod)) {
        if (typeof exported !== 'function') continue;
        if (Reflect.getMetadata(PATH_METADATA, exported) !== undefined) {
          continue;
        }
        const keys = GATE_KEYS.filter(
          (key) => Reflect.getMetadata(key, exported) !== undefined,
        );
        if (keys.length) {
          misplaced.push(
            `${relative(src, file)}: ${name} (${keys.join(', ')})`,
          );
        }
      }
    }
    expect(misplaced).toEqual([]);
  });
});
