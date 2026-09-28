import { NestFactory } from '@nestjs/core';
import { INestApplication } from '@nestjs/common';
import { CliModule } from '../cli.module';
import { ProfileManager } from './profile-manager';
import { withCliEncryptionKey } from './vault/encryption-key-env';

let appInstance: INestApplication | null = null;

/**
 * Ensure base .flui directory exists and migrate legacy layout if needed.
 */
function ensureCliDataDir(): void {
  ProfileManager.migrateIfNeeded();
}

/**
 * Get or create NestJS application (singleton)
 * Uses full NestJS application instead of just application context
 * to support TypeORM and Bull which require ModuleRef
 * @returns NestJS application
 */
export async function getNestApp(): Promise<INestApplication> {
  if (!appInstance) {
    // Ensure data directory exists before bootstrap
    ensureCliDataDir();

    // CLI does not use Redis — disable cache unless explicitly enabled
    process.env.CACHE_ENABLED ??= 'false';

    // Create full NestJS application (with HTTP server but we won't listen)
    // This is required for TypeORM and Bull to work properly
    appInstance = await withCliEncryptionKey(() =>
      NestFactory.create(CliModule, {
        logger: ['error', 'warn'], // Only show errors and warnings
        abortOnError: true, // Exit on errors to see what's wrong
      }),
    );

    // Don't call init() - NestFactory.create() already initializes the app
  }
  return appInstance;
}

/**
 * Close NestJS application context and cleanup
 */
export async function closeNestApp(): Promise<void> {
  if (appInstance) {
    await appInstance.close();
    appInstance = null;
  }
  // process.exit() drops pending async pipe writes — flush first.
  await Promise.all([
    new Promise<void>((resolve) => {
      if (!process.stdout.writable) return resolve();
      process.stdout.write('', () => resolve());
    }),
    new Promise<void>((resolve) => {
      if (!process.stderr.writable) return resolve();
      process.stderr.write('', () => resolve());
    }),
  ]);
  // Bull/TypeORM keepalive timers prevent natural exit.
  process.exit(process.exitCode ?? 0);
}

/**
 * Get service from NestJS DI container
 * Convenience helper for type-safe service retrieval
 */
export async function getService<T>(
  serviceClass: new (...args: any[]) => T,
): Promise<T> {
  const app = await getNestApp();
  return app.get(serviceClass);
}
