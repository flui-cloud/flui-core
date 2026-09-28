import * as dotenv from 'dotenv';

/**
 * Loaded before anything else in `main.ts`. Decorators such as
 * `@Cron(process.env.X || …)` read the environment while `AppModule` is being
 * imported, long before `ConfigModule` loads these files — so a schedule set
 * in `.env.local` was silently ignored by a local API. Same files, same order
 * as `ConfigModule` (`.env.local` wins), and never over a variable the
 * process already has.
 */
dotenv.config({ path: ['.env.local', '.env'] });
