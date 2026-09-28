import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('load-env', () => {
  const cwd = process.cwd();
  afterEach(() => {
    process.chdir(cwd);
    delete process.env.FLUI_LOAD_ENV_PROBE;
    delete process.env.FLUI_LOAD_ENV_ONLY_ENV;
    jest.resetModules();
  });

  it('reads .env.local before .env, so a schedule set locally reaches the decorators', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flui-env-'));
    writeFileSync(join(dir, '.env.local'), 'FLUI_LOAD_ENV_PROBE=local\n');
    writeFileSync(
      join(dir, '.env'),
      'FLUI_LOAD_ENV_PROBE=shared\nFLUI_LOAD_ENV_ONLY_ENV=yes\n',
    );
    process.chdir(dir);
    await jest.isolateModulesAsync(async () => {
      await import('./load-env');
    });
    expect(process.env.FLUI_LOAD_ENV_PROBE).toBe('local');
    expect(process.env.FLUI_LOAD_ENV_ONLY_ENV).toBe('yes');
  });

  it('never overrides what the process was started with', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'flui-env-'));
    writeFileSync(join(dir, '.env'), 'FLUI_LOAD_ENV_PROBE=file\n');
    process.env.FLUI_LOAD_ENV_PROBE = 'process';
    process.chdir(dir);
    await jest.isolateModulesAsync(async () => {
      await import('./load-env');
    });
    expect(process.env.FLUI_LOAD_ENV_PROBE).toBe('process');
  });
});
