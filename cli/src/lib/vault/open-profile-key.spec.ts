import { openProfileKey } from './open-profile-key';
import { askAgent } from './vault-agent';
import { forgetProfileKeys, getProfileKey } from './session-key';
import { SUPPLIED_KEY_VAR } from './supplied-key';

jest.mock('./vault-agent', () => ({ askAgent: jest.fn() }));

const asked = askAgent as jest.MockedFunction<typeof askAgent>;
const KEY = Buffer.alloc(32, 7);

describe('opening a profile key', () => {
  afterEach(() => {
    delete process.env[SUPPLIED_KEY_VAR];
    forgetProfileKeys();
    asked.mockReset();
  });

  it('takes the key the caller supplied, and never asks the agent for one', async () => {
    process.env[SUPPLIED_KEY_VAR] = KEY.toString('base64');

    await openProfileKey('staging');

    expect(getProfileKey('staging')).toEqual(KEY);
    expect(asked).not.toHaveBeenCalled();
  });

  it('stops on a supplied key that is malformed rather than falling through', async () => {
    process.env[SUPPLIED_KEY_VAR] = 'not-a-key';

    await expect(openProfileKey('staging')).rejects.toThrow(SUPPLIED_KEY_VAR);
  });

  it('asks the agent when the caller supplied nothing', async () => {
    asked.mockResolvedValue({ ok: true, key: KEY.toString('base64') } as never);

    await openProfileKey('staging');

    expect(getProfileKey('staging')).toEqual(KEY);
  });

  /**
   * A locked vault is a normal state, not a fault: most work needs no
   * credential, and the one call that does says so in context.
   */
  it('leaves the profile without a key when no agent answers', async () => {
    asked.mockResolvedValue(null);

    await expect(openProfileKey('staging')).resolves.toBeUndefined();
    expect(getProfileKey('staging')).toBeNull();
  });
});
