import { Injectable, Logger } from '@nestjs/common';

/**
 * The browser terminal is the only feature that needs the SSH CA private key to
 * live inside the cluster: it signs a certificate per session, so the key has to
 * be reachable by the API.
 *
 * That makes it the reason a database dump of a control plane yields root on
 * every node it manages — the highest-privilege path in the product, reachable
 * over HTTP. It is therefore **off unless asked for**. A default installation
 * has no CA in the cluster and no way to open a shell from the browser, which
 * collapses that chain at the root rather than trying to encrypt around it.
 *
 * Turning it on is a deliberate act: set `FLUI_WEB_TERMINAL_ENABLED=true`, and
 * seed the CA with `flui env repair-ssh-ca`.
 */
@Injectable()
export class TerminalFeatureConfig {
  private readonly logger = new Logger(TerminalFeatureConfig.name);
  private warned = false;

  get enabled(): boolean {
    return process.env.FLUI_WEB_TERMINAL_ENABLED === 'true';
  }

  /** Logged once, so an operator who expects a shell knows why there isn't one. */
  noteDisabled(): void {
    if (this.enabled || this.warned) return;
    this.warned = true;
    this.logger.log(
      'Browser terminal is disabled (FLUI_WEB_TERMINAL_ENABLED is not "true"). ' +
        'The SSH CA is not required in-cluster while it stays off.',
    );
  }
}

export const TERMINAL_DISABLED_MESSAGE =
  'The browser terminal is turned off on this installation. Use "flui ssh" from your own machine, or enable it with FLUI_WEB_TERMINAL_ENABLED=true.';
