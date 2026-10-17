import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { ALL_TOOLS } from './tool-registry';
import { SCOPE_TIER } from '../constants/mcp-scopes';
import { ALWAYS_ASK_ACTIONS } from '../../action-cycle/action-cycle.core';

/**
 * Destructive tools are offered without an operator switch because every call
 * stops for a person. That holds only while each route they reach is declared
 * to the approval cycle and answered every time; a new destructive tool on an
 * undeclared route would delete without asking. This is what says so.
 */
const SRC = join(__dirname, '..', '..', '..');

function controllerSources(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) controllerSources(path, out);
    else if (name.endsWith('.controller.ts'))
      out.push(readFileSync(path, 'utf8'));
  }
  return out;
}

const declared = controllerSources(SRC).join('\n');

const destructiveRoutes = ALL_TOOLS.filter(
  (t) => SCOPE_TIER[t.scope] === 'destructive',
).flatMap((t) => (t.routes ?? []).map((route) => [t.name, route] as const));

describe('every destructive tool stops for a person, every time', () => {
  it('has destructive tools to check', () => {
    expect(destructiveRoutes.length).toBeGreaterThan(5);
  });

  it.each(destructiveRoutes)('%s: %s asks every time', (_tool, route) => {
    expect(ALWAYS_ASK_ACTIONS.has(route)).toBe(true);
  });

  it.each(destructiveRoutes)(
    '%s: %s is declared to the approval cycle',
    (_tool, route) => {
      expect(declared).toContain(`action: '${route}'`);
    },
  );

  it.each([...ALWAYS_ASK_ACTIONS])(
    '%s is declared to the approval cycle',
    (route) => {
      expect(declared).toContain(`action: '${route}'`);
    },
  );
});
