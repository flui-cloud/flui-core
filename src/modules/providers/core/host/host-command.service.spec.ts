import { ServiceUnavailableException } from '@nestjs/common';
import { HostCommandService } from './host-command.service';

const target = { host: '10.0.0.1', port: 22, user: 'root' };

describe('HostCommandService', () => {
  const build = (exec: jest.Mock) =>
    new HostCommandService(
      {
        generateEphemeralCertificate: jest.fn().mockResolvedValue({
          privateKey: 'k',
          certificate: 'c',
        }),
      } as any,
      { execCommand: exec } as any,
    );

  it('mints a fresh short-lived certificate for every run', async () => {
    const signer = {
      generateEphemeralCertificate: jest
        .fn()
        .mockResolvedValue({ privateKey: 'k', certificate: 'c' }),
    };
    const svc = new HostCommandService(
      signer as any,
      {
        execCommand: jest.fn().mockResolvedValue('ok'),
      } as any,
    );

    await svc.run(target, 'true');
    await svc.run(target, 'true');

    expect(signer.generateEphemeralCertificate).toHaveBeenCalledTimes(2);
  });

  describe('apply', () => {
    it('accepts output containing the marker', async () => {
      const svc = build(jest.fn().mockResolvedValue('doing things\nFLUI_OK\n'));
      await expect(svc.apply(target, 'script', 'FLUI_OK')).resolves.toContain(
        'FLUI_OK',
      );
    });

    it('rejects a clean exit that never reached the marker', async () => {
      // The failure this guards: a script exits 0 having done nothing — a
      // missing binary swallowed by `|| true`, a heredoc left open — and the
      // caller records a change that is not on the host.
      const svc = build(jest.fn().mockResolvedValue('nft: command not found'));
      await expect(svc.apply(target, 'script', 'FLUI_OK')).rejects.toThrow(
        /FLUI_OK not confirmed on 10\.0\.0\.1:22/,
      );
    });
  });

  describe('applyAll', () => {
    it('stops at the first host that does not confirm', async () => {
      const exec = jest
        .fn()
        .mockResolvedValueOnce('FLUI_OK')
        .mockResolvedValueOnce('silent failure');
      const svc = build(exec);

      await expect(
        svc.applyAll(
          [
            target,
            { ...target, host: '10.0.0.2' },
            { ...target, host: '10.0.0.3' },
          ],
          'script',
          'FLUI_OK',
        ),
      ).rejects.toThrow(/10\.0\.0\.2/);

      expect(exec).toHaveBeenCalledTimes(2);
    });
  });

  it('reports an unreachable host as unavailable, not as a generic failure', async () => {
    const svc = build(
      jest.fn().mockRejectedValue(new Error('connection refused')),
    );
    await expect(svc.run(target, 'true')).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
  });

  it('leaves a genuine command failure as-is', async () => {
    const svc = build(jest.fn().mockRejectedValue(new Error('exit code 1')));
    await expect(svc.run(target, 'true')).rejects.toThrow('exit code 1');
  });
});
