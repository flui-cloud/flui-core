import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { CertificateSignerService } from 'src/modules/access/services/certificate-signer.service';
import { NativeSSHConnectionService } from 'src/modules/terminal/services/native-ssh-connection.service';
import { HostTarget } from './host-targets';

const DEFAULT_TIMEOUT_MS = 60_000;
/** Long enough to cover a slow connect plus the script itself; the certificate
 *  is single-use and dies on its own either way. */
const DEFAULT_CERT_TTL_SECONDS = 300;

export interface HostCommandOptions {
  timeoutMs?: number;
  certTtlSeconds?: number;
}

/**
 * Runs a script on a cluster node over SSH, authenticated with a short-lived
 * certificate minted per invocation.
 *
 * Deliberately not a queue, an agent, or a daemon: an agent on the node is a
 * thing to install, authenticate, update and debug. A short SSH session
 * carrying an idempotent script is enough, and it fails loudly.
 */
@Injectable()
export class HostCommandService {
  private readonly logger = new Logger(HostCommandService.name);

  constructor(
    private readonly certificateSigner: CertificateSignerService,
    private readonly nativeSsh: NativeSSHConnectionService,
  ) {}

  async run(
    target: HostTarget,
    script: string,
    options: HostCommandOptions = {},
  ): Promise<string> {
    const cert = await this.certificateSigner.generateEphemeralCertificate(
      undefined,
      options.certTtlSeconds ?? DEFAULT_CERT_TTL_SECONDS,
    );
    try {
      return await this.nativeSsh.execCommand(
        target.host,
        target.user,
        cert.privateKey,
        script,
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        { certificate: cert.certificate, port: target.port },
      );
    } catch (error) {
      throw toReachabilityError(error, target);
    }
  }

  /**
   * Runs a script that must print `marker` as proof it reached the end.
   *
   * A script can exit 0 having done nothing useful — a missing binary swallowed
   * by `|| true`, a heredoc that never closed. The marker is the difference
   * between "SSH returned" and "the change is in place".
   */
  async apply(
    target: HostTarget,
    script: string,
    marker: string,
    options: HostCommandOptions = {},
  ): Promise<string> {
    const out = await this.run(target, script, options);
    if (!out.includes(marker)) {
      throw new Error(
        `${marker} not confirmed on ${target.host}:${target.port}: ` +
          `${out.trim().slice(-200)}`,
      );
    }
    return out;
  }

  /** Sequential on purpose: these scripts rewrite firewall and network state,
   *  and a half-applied fleet is easier to reason about than a racing one. */
  async applyAll(
    targets: HostTarget[],
    script: string,
    marker: string,
    options: HostCommandOptions = {},
  ): Promise<void> {
    for (const target of targets) {
      this.logger.log(`Applying to ${target.host}:${target.port}`);
      await this.apply(target, script, marker, options);
    }
  }
}

/**
 * Turns an SSH failure into an error that says what to check.
 *
 * Reachability failures are the common case and the confusing one, because the
 * connection Flui is using is often the very thing being reconfigured.
 */
export function toReachabilityError(error: unknown, target: HostTarget): Error {
  const msg = error instanceof Error ? error.message : String(error);
  const unreachable =
    /connection refused|connection timed out|timed out|no route to host|could not resolve|permission denied|host key verification|code 255/i.test(
      msg,
    );
  if (unreachable) {
    return new ServiceUnavailableException(
      `Cannot reach node ${target.host}:${target.port} over SSH — the host firewall is applied over SSH. ` +
        `Check the cluster's SSH connection settings (host, port, user). (${msg})`,
    );
  }
  return error instanceof Error ? error : new Error(msg);
}
