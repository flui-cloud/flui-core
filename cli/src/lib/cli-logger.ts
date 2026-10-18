import { ConsoleLogger, LogLevel } from '@nestjs/common';

const DEBUG = () => !!process.env['FLUI_DEBUG'];

/**
 * The services' log lines, without their stack traces: a person running a
 * command reads "the token is invalid", not forty lines of axios internals.
 * FLUI_DEBUG=1 puts the traces back.
 */
export class CliLogger extends ConsoleLogger {
  protected printStackTrace(stack: string): void {
    if (DEBUG()) super.printStackTrace(stack);
  }

  protected printMessages(
    messages: unknown[],
    context?: string,
    logLevel?: LogLevel,
    writeStreamType?: 'stdout' | 'stderr',
    errorStack?: unknown,
  ): void {
    const shown = DEBUG()
      ? messages
      : messages.map((m) =>
          m instanceof Error ? `${m.name}: ${m.message}` : m,
        );
    super.printMessages(
      shown,
      context,
      logLevel,
      writeStreamType,
      DEBUG() ? errorStack : undefined,
    );
  }
}
