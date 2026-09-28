import { z } from 'zod';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';
import { PLATFORM_UPDATE_TOOLS } from './platform-update.tools';
import { ALL_TOOLS } from './tool-registry';
import { McpToolContext, isExecutable, runTool } from './mcp-tool.util';
import {
  DEFAULT_SCOPES,
  MCP_SCOPE,
  SCOPE_TIER,
  TIER_SCOPES,
} from '../constants/mcp-scopes';
import { SCOPE_AUTHORITY } from '../../auth/constants/api-key-scopes';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { isOfferedToGuest } from '../services/sandbox-tool-visibility';
import { WITHOUT_BACKUP_ACKNOWLEDGEMENT } from '../../platform-updates/interfaces/platform-upgrade.interface';

const MODULES = join(__dirname, '..', '..');

function controllerFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...controllerFiles(full));
    else if (entry.endsWith('.controller.ts')) out.push(full);
  }
  return out;
}

function cycled(): Set<string> {
  const found = new Set<string>();
  for (const file of controllerFiles(MODULES)) {
    const source = readFileSync(file, 'utf8');
    for (const rest of source.split('@ActionCycle({').slice(1)) {
      const action = /action:\s*\n?\s*'([^']+)'/.exec(rest)?.[1];
      if (action) found.add(action);
    }
  }
  return found;
}

const CYCLED = cycled();
const tool = (name: string) =>
  PLATFORM_UPDATE_TOOLS.find((t) => t.name === name)!;

describe('updating the platform from an agent', () => {
  it('publishes the three tools', () => {
    expect(PLATFORM_UPDATE_TOOLS.map((t) => t.name).sort()).toEqual([
      'platform_update_apply',
      'platform_update_plan',
      'platform_update_status',
    ]);
    for (const t of PLATFORM_UPDATE_TOOLS) {
      expect(ALL_TOOLS).toContain(t);
    }
  });

  it('sends the apply to a route that asks a person first', () => {
    for (const route of tool('platform_update_apply').routes ?? []) {
      expect(CYCLED.has(route)).toBe(true);
    }
  });

  it('leaves the plan and the status outside the cycle', () => {
    for (const name of ['platform_update_plan', 'platform_update_status']) {
      for (const route of tool(name).routes ?? []) {
        expect({ name, route, cycled: CYCLED.has(route) }).toEqual({
          name,
          route,
          cycled: false,
        });
      }
    }
  });

  it('re-implements no part of the cycle in the tool', () => {
    for (const t of PLATFORM_UPDATE_TOOLS) {
      const args = Object.keys(t.inputSchema);
      for (const forbidden of [
        'confirm',
        'confirmed',
        'approve',
        'approved',
        'force',
        'proposalId',
      ]) {
        expect({
          tool: t.name,
          forbidden,
          present: args.includes(forbidden),
        }).toEqual({ tool: t.name, forbidden, present: false });
      }
      expect(t.run.toString()).not.toMatch(/proposal/i);
    }
  });

  it('requires the plan id to apply', () => {
    const schema = z.object(tool('platform_update_apply').inputSchema);
    expect(schema.safeParse({ targetVersion: '0.20.0' }).success).toBe(false);
    expect(
      schema.safeParse({ targetVersion: '0.20.0', planId: 'p1' }).success,
    ).toBe(true);
  });

  it('carries the acknowledgement it was given, word for word', async () => {
    const posts: unknown[] = [];
    const ctx = {
      user: { userId: 'u1', email: 'a@x' },
      scopes: new Set<string>(Object.values(MCP_SCOPE)),
      allowDestructive: false,
      surface: 'mcp',
      audit: { record: jest.fn() },
      api: {
        post: (_p: string, body: unknown) => {
          posts.push(body);
          return Promise.resolve({ id: 'op1', status: 'PENDING' });
        },
      },
    } as unknown as McpToolContext;
    await runTool(ctx, tool('platform_update_apply'), {
      targetVersion: '0.20.0',
      planId: 'p1',
      withoutBackup: true,
      acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT,
    });
    expect(posts[0]).toEqual({
      targetVersion: '0.20.0',
      planId: 'p1',
      withoutBackup: true,
      acknowledgement: WITHOUT_BACKUP_ACKNOWLEDGEMENT,
    });
    expect(tool('platform_update_apply').description).toContain(
      WITHOUT_BACKUP_ACKNOWLEDGEMENT,
    );
  });

  it('holds platform:update in its own scope, and nothing more', () => {
    expect(SCOPE_AUTHORITY[MCP_SCOPE.PLATFORM_UPDATE]).toEqual({
      requires: IAM_PERMISSION.PLATFORM_UPDATE,
      allows: [IAM_PERMISSION.PLATFORM_UPDATE],
    });
    for (const scope of [MCP_SCOPE.INFRA_WRITE, MCP_SCOPE.INFRA_DESTRUCTIVE]) {
      expect(SCOPE_AUTHORITY[scope].allows).not.toContain(
        IAM_PERMISSION.PLATFORM_UPDATE,
      );
    }
  });

  it('is carried by no tier, so an unscoped key never acquires it by silence', () => {
    for (const scopes of Object.values(TIER_SCOPES)) {
      expect(scopes as string[]).not.toContain(MCP_SCOPE.PLATFORM_UPDATE);
    }
    expect(DEFAULT_SCOPES as string[]).not.toContain(MCP_SCOPE.PLATFORM_UPDATE);
  });

  it('reads the plan even with destructive tools switched off', () => {
    expect(SCOPE_TIER[MCP_SCOPE.PLATFORM_UPDATE]).toBe('write');
    const ctx = {
      scopes: new Set<string>([MCP_SCOPE.PLATFORM_UPDATE]),
      allowDestructive: false,
    } as unknown as McpToolContext;
    expect(isExecutable(ctx, tool('platform_update_plan'))).toBe(true);
    expect(
      isExecutable(
        { ...ctx, scopes: new Set<string>([MCP_SCOPE.INFRA_WRITE]) },
        tool('platform_update_apply'),
      ),
    ).toBe(false);
  });

  it('offers none of it to a sandbox guest', () => {
    for (const t of PLATFORM_UPDATE_TOOLS) {
      expect({ tool: t.name, offered: isOfferedToGuest(t) }).toEqual({
        tool: t.name,
        offered: false,
      });
    }
  });
});
