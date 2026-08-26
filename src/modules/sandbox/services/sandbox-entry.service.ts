import { Inject, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { SANDBOX_CONFIG, SandboxConfig } from '../sandbox.config';
import {
  describeSandboxEntry,
  entryUrl,
  loginUrl,
  resumeLink,
} from '../sandbox-entry';

/**
 * Owns where the sandbox's front door is, so that no surface has to build it.
 *
 * The door is a value of the environment, never of the code: the same build
 * serves a laptop on `localhost:4200` and a public instance on its own name, and
 * moving from one to the other is a variable rather than an edit. What the code
 * fixes is only the *shape* — an origin plus `/try`.
 */
@Injectable()
export class SandboxEntryService implements OnModuleInit {
  private readonly logger = new Logger(SandboxEntryService.name);

  constructor(@Inject(SANDBOX_CONFIG) private readonly config: SandboxConfig) {}

  /** Origin a claimed tenancy is opened on. */
  get origin(): string {
    return loginUrl(this.config.baseDomain);
  }

  /** The single entrance a visitor is ever sent to. */
  get entryUrl(): string {
    return entryUrl(this.config.baseDomain);
  }

  resumeLink(token: string): string {
    return resumeLink(this.config.baseDomain, token);
  }

  /**
   * Say the door out loud at boot.
   *
   * Only when the sandbox is on: an instance that does not run one has no door
   * to be wrong about, and a warning about a switch nobody threw is noise.
   */
  onModuleInit(): void {
    if (!this.config.enabled) return;
    const report = describeSandboxEntry(this.config.baseDomain);
    if (report.verdict === 'placeholder') {
      this.logger.warn(report.message);
      return;
    }
    this.logger.log(report.message);
  }
}
