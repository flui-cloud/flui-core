jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('chalk', () => {
  const same = (text: string) => text;
  const chalk: any = new Proxy(same, { get: () => chalk });
  return { __esModule: true, default: chalk };
});
jest.mock('ora', () => ({ __esModule: true, default: () => ({}) }));
jest.mock('inquirer', () => ({ __esModule: true, default: {} }));

import Swap from './swap';
import Discard from './discard';
import Delete from './delete';
import PolicyDelete from '../../backup/policy/delete';

describe('the confirmation flag of neighbouring commands', () => {
  it.each([
    ['app snapshot swap', Swap],
    ['app snapshot discard', Discard],
    ['app snapshot delete', Delete],
    ['backup policy delete', PolicyDelete],
  ])('%s takes --yes/-y, and still --force/-f', (_name, command) => {
    const yes = (command as any).flags.yes;
    expect(yes.char).toBe('y');
    expect(yes.aliases).toContain('force');
    expect(yes.charAliases).toContain('f');
    expect((command as any).flags.force).toBeUndefined();
  });
});
