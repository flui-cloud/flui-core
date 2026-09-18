jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: jest.fn() }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

import { Logger } from '@nestjs/common';
import type { ChildProcess } from 'node:child_process';
import { NativeSSHConnectionService } from './native-ssh-connection.service';
import { TerminalGateway } from '../gateways/terminal.gateway';

/**
 * F-027 and F-034 of the September 2026 register.
 *
 * Both are about the same channel. What a person types into a root shell
 * included the passwords they were prompted for, and the first fifty characters
 * of it went to the log; and the window dimensions arrive over a socket and are
 * written into a command line on the far end, where anything that is not a
 * small integer is a way to append to that line.
 */

function connection() {
  const written: string[] = [];
  const process = {
    stdin: { writable: true, write: (s: string) => written.push(s) },
  } as unknown as ChildProcess;
  return { process, written };
}

describe('what the terminal writes to the remote shell', () => {
  let logged: string[];
  let service: NativeSSHConnectionService;

  beforeEach(() => {
    logged = [];
    for (const level of ['log', 'warn', 'error', 'debug', 'verbose'] as const) {
      jest
        .spyOn(Logger.prototype, level)
        .mockImplementation((...args: unknown[]) => {
          logged.push(args.map((a) => String(a)).join(' '));
        });
    }
    service = new NativeSSHConnectionService();
  });
  afterEach(() => jest.restoreAllMocks());

  describe('keystrokes', () => {
    it('reach the shell but never the log', () => {
      const { process, written } = connection();
      const secret = 'hunter2-the-password-they-were-prompted-for\r';

      service.writeData(process, secret);

      expect(written).toEqual([secret]);
      expect(logged.join('\n')).not.toContain('hunter2');
      expect(logged.join('\n')).not.toContain(secret.slice(0, 20));
    });
  });

  describe('keystrokes at the gateway', () => {
    // The sink the register actually named. Asserted separately because the two
    // are different objects: reverting either one alone must fail something.
    it('reach the service but never the log', async () => {
      const terminalService = { writeToConnection: jest.fn() };
      const gateway = new TerminalGateway(
        terminalService as never,
        {} as never,
        {} as never,
        {} as never,
      );
      const secret = 'correct-horse-battery-staple\r';

      await gateway.handleInput(
        { id: 'socket-1', emit: jest.fn() } as never,
        { data: secret } as never,
      );

      expect(terminalService.writeToConnection).toHaveBeenCalledWith(
        'socket-1',
        secret,
      );
      expect(logged.join('\n')).not.toContain('correct-horse');
    });
  });

  describe('the window size', () => {
    const sttyLine = (rows: unknown, cols: unknown): string => {
      const { process, written } = connection();
      service.resizeTerminal(process, rows as number, cols as number);
      return written.join('');
    };

    it('is passed through when it is an ordinary size', () => {
      expect(sttyLine(40, 120)).toContain('stty rows 40 cols 120');
    });

    it.each([
      ['0; id #', 'a command appended after a semicolon'],
      ['$(id)', 'a substitution'],
      ['`id`', 'a backquoted command'],
      ['1\nid', 'a second line'],
      ['NaN', 'not a number at all'],
    ])('never lets %p through (%s)', (hostile) => {
      const line = sttyLine(hostile, hostile);

      // The anchored pattern is the whole assertion: nothing but digits can
      // reach the line, so there is nothing left to look for inside it.
      //
      // The control character is the subject, not an accident: the line must
      // open with Ctrl-U so whatever the user had half-typed is discarded
      // before `stty` is written. Matching it is the point of the test.
      // eslint-disable-next-line sonarjs/no-control-regex
      expect(line).toMatch(/^\x15stty rows \d+ cols \d+\r$/);
    });

    it('clamps a size that is out of range rather than tearing the session down', () => {
      expect(sttyLine(-5, 10_000)).toContain('stty rows 1 cols 500');
      expect(sttyLine(24.9, 80.4)).toContain('stty rows 24 cols 80');
    });
  });
});
