import { ConfigService } from '@nestjs/config';
import { AgentSkillController } from './agent-skill.controller';
import { ApiKeyService } from '../services/api-key.service';
import { CURRENT_API_KEY_ID } from '../strategies/api-key.strategy';
import { AGENT_SKILL_VERSION } from '../constants/agent-skill';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';

const USER: AuthenticatedUser = {
  userId: 'u1',
  email: 'a@b.c',
} as AuthenticatedUser;

const KEY = {
  id: 'k1',
  name: 'Claude Code on my laptop',
  scopes: ['mcp:app:read'],
  expiresAt: new Date('2030-01-01T00:00:00.000Z'),
};

function build(config: Record<string, string> = {}) {
  const apiKeys = {
    findById: jest.fn().mockResolvedValue(KEY),
    recordSkillVersion: jest.fn().mockResolvedValue(true),
  };
  const controller = new AgentSkillController(
    apiKeys as unknown as ApiKeyService,
    { get: (k: string) => config[k] } as unknown as ConfigService,
  );
  return { controller, apiKeys };
}

const withKey = (keyId?: string) =>
  ({ user: USER, ...(keyId ? { [CURRENT_API_KEY_ID]: keyId } : {}) }) as never;

describe('AgentSkillController', () => {
  describe('handing over the skill', () => {
    it('addresses the instance by its configured public name', () => {
      const { controller } = build({ API_BASE_URL: 'https://flui.example/' });
      const skill = controller.skill();
      expect(skill.mcpEndpoint).toBe('https://flui.example/api/v1/mcp');
      expect(skill.content).toContain('https://flui.example/api/v1/mcp');
    });

    /**
     * A document that names `localhost` on an instance somebody reaches by
     * name is not a smaller mistake than an empty one: the agent follows it and
     * connects to its own machine.
     */
    it('prefers the variable meant for this over the generic one', () => {
      const { controller } = build({
        PUBLIC_API_URL: 'https://public.example',
        API_BASE_URL: 'https://internal.example',
      });
      expect(controller.skill().mcpEndpoint).toBe(
        'https://public.example/api/v1/mcp',
      );
    });

    it('falls back to the port it listens on rather than emitting nothing', () => {
      const { controller } = build({ PORT: '4000' });
      expect(controller.skill().mcpEndpoint).toBe(
        'http://localhost:4000/api/v1/mcp',
      );
    });

    it('carries a version and a digest, which is what makes staleness answerable', () => {
      const { controller } = build();
      const skill = controller.skill();
      expect(skill.version).toBe(AGENT_SKILL_VERSION);
      expect(skill.digest).toMatch(/^[0-9a-f]{12}$/);
      expect(skill.filename).toBe('SKILL.md');
    });

    it('never reads a credential to produce it', () => {
      const { controller, apiKeys } = build();
      controller.skill();
      expect(apiKeys.findById).not.toHaveBeenCalled();
    });
  });

  describe('the agent’s half: what am I attached to', () => {
    it('names the credential it is holding, its scopes and its expiry', async () => {
      const { controller } = build({ API_BASE_URL: 'https://flui.example' });
      const result = await controller.checkIn(withKey('k1'), {
        skillVersion: AGENT_SKILL_VERSION,
      });
      expect(result).toMatchObject({
        credentialName: 'Claude Code on my laptop',
        scopes: ['mcp:app:read'],
        expiresAt: KEY.expiresAt,
        mcpEndpoint: 'https://flui.example/api/v1/mcp',
        skillFreshness: 'current',
      });
    });

    it('tells an out-of-date agent it is out of date', async () => {
      const { controller } = build();
      const result = await controller.checkIn(withKey('k1'), {
        skillVersion: '0.0.1',
      });
      expect(result.skillFreshness).toBe('stale');
      expect(result.currentSkillVersion).toBe(AGENT_SKILL_VERSION);
      expect(result.declaredSkillVersion).toBe('0.0.1');
    });
  });

  describe('the person’s half: is this key alive, and what is it reading', () => {
    it('writes the declared version to the key that made the call', async () => {
      const { controller, apiKeys } = build();
      const result = await controller.checkIn(withKey('k1'), {
        skillVersion: '1.0.0',
      });
      expect(apiKeys.recordSkillVersion).toHaveBeenCalledWith('k1', '1.0.0');
      expect(result.recorded).toBe(true);
    });

    /**
     * `recorded` is a claim about the database, and the reply is the only place
     * anybody could learn it was false. Reporting `true` on a write that did
     * not land would leave an agent believing it had announced itself while the
     * panel goes on showing silence.
     */
    it('says so when the write found no row', async () => {
      const { controller, apiKeys } = build();
      apiKeys.recordSkillVersion.mockResolvedValue(false);
      const result = await controller.checkIn(withKey('k1'), {
        skillVersion: '1.0.0',
      });
      expect(result.recorded).toBe(false);
    });

    /**
     * An interactive session has no key row to be the connection. Minting one
     * would put a credential in somebody's panel that they never issued.
     */
    it('records nothing for a session that arrived without an API key', async () => {
      const { controller, apiKeys } = build();
      const result = await controller.checkIn(withKey(), {
        skillVersion: '1.0.0',
      });
      expect(apiKeys.findById).not.toHaveBeenCalled();
      expect(apiKeys.recordSkillVersion).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        recorded: false,
        credentialName: null,
        scopes: null,
      });
    });

    it('records nothing when the agent declared no version', async () => {
      const { controller, apiKeys } = build();
      const result = await controller.checkIn(withKey('k1'), {});
      expect(apiKeys.recordSkillVersion).not.toHaveBeenCalled();
      expect(result.skillFreshness).toBe('undeclared');
      expect(result.recorded).toBe(false);
    });

    /**
     * The last contact, and only the last contact. A check-in overwrites its
     * predecessor rather than appending — the panel needs to know what the
     * agent is reading now, and a series of these would be a movement log of
     * somebody's agent kept in a table nobody audits.
     */
    it('overwrites rather than accumulating', async () => {
      const { controller, apiKeys } = build();
      await controller.checkIn(withKey('k1'), { skillVersion: '0.9.0' });
      await controller.checkIn(withKey('k1'), { skillVersion: '1.0.0' });
      expect(apiKeys.recordSkillVersion.mock.calls).toEqual([
        ['k1', '0.9.0'],
        ['k1', '1.0.0'],
      ]);
    });
  });
});
