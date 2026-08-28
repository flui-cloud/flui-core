import { NestFactory } from '@nestjs/core';
import { corsOriginDelegate } from './config/cors-origin.config';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe, Logger, ConsoleLogger } from '@nestjs/common';
import { HttpExceptionFilter } from './filters/http-exception.filter';
import { MalformedIdentifierFilter } from './filters/malformed-identifier.filter';
import { runWithActorContext } from './modules/auth/utils/actor-context';
import Redis from 'ioredis';

dotenv.config();

async function performPreBootstrapChecks(): Promise<void> {
  const logger = new Logger('PreBootstrap');
  const skipChecks = process.env.SKIP_STARTUP_CHECKS === 'true';

  if (skipChecks) {
    logger.warn('⚠️  Pre-bootstrap health checks are DISABLED');
    return;
  }

  const deploymentMode = (process.env.DEPLOYMENT_MODE || 'local').toLowerCase();
  logger.log(`🔍 Running pre-bootstrap checks (mode: ${deploymentMode})`);

  // Check Redis connection before Bull tries to connect
  const redisHost = process.env.REDIS_HOST || 'localhost';
  const redisPort = Number.parseInt(process.env.REDIS_PORT || '6379', 10);
  const redisPassword = process.env.REDIS_PASSWORD;

  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    password: redisPassword,
    connectTimeout: 5000,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    await redis.ping();
    await redis.quit();
    logger.log('✅ Redis connection successful');
  } catch (error) {
    redis.disconnect();

    const errorMessage = [
      '',
      '━'.repeat(70),
      '  🚨 STARTUP FAILED: Redis Connection Failed',
      '━'.repeat(70),
      '',
      `   Host: ${redisHost}:${redisPort}`,
      `   Error: ${error.code || error.message}`,
      '',
      '━'.repeat(70),
      '',
    ].join('\n');

    logger.error(errorMessage);
    process.exit(1);
  }
}

/**
 * Walks the OpenAPI document and copies any `x-enumNames` extension (preserved
 * by @nestjs/swagger) onto a sibling `x-enum-varnames` extension. OpenAPI
 * Generator's TypeScript templates use `x-enum-varnames` to derive identifier
 * names for enum members — without it, enum values containing characters that
 * aren't valid in JS identifiers (e.g. `${...}`, `#{...}#`) produce broken,
 * uncompilable client code on the consumer side.
 *
 * To opt a DTO field into stable codegen names, declare `x-enumNames` next to
 * `enum` in its `@ApiProperty()` decorator — the array order must match the
 * `enum` declaration order.
 */
function addEnumVarnamesExtension<T>(document: T): T {
  const visit = (node: unknown): void => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    const obj = node as Record<string, unknown>;
    if (
      Array.isArray(obj['enum']) &&
      Array.isArray(obj['x-enumNames']) &&
      !obj['x-enum-varnames']
    ) {
      obj['x-enum-varnames'] = obj['x-enumNames'];
    }
    for (const key of Object.keys(obj)) visit(obj[key]);
  };
  visit(document);
  return document;
}

async function bootstrap() {
  await performPreBootstrapChecks();

  const isProduction = process.env.NODE_ENV === 'production';
  const app = await NestFactory.create(AppModule, {
    logger: isProduction ? new ConsoleLogger({ json: true }) : undefined,
    // Keep the bytes as they arrived, for the webhook handlers that verify a
    // signature over them. Without it `req.rawBody` is undefined and the only
    // fallback is re-serialising the parsed body — a different string whenever
    // key order or spacing differs, which turns a correct signature into a
    // permanent mismatch.
    rawBody: true,
  });

  // Opens the per-request actor context. It has to wrap the whole request —
  // guards included, since the guard is what fills it — so it is middleware and
  // not an interceptor: an interceptor returns an Observable that Nest
  // subscribes to after the interceptor chain has returned, i.e. outside any
  // AsyncLocalStorage.run() opened around it. See auth/utils/actor-context.
  app.use((_req: unknown, _res: unknown, next: () => void) =>
    runWithActorContext(next),
  );

  // Global prefix
  app.setGlobalPrefix('api/v1');

  // Validation pipe
  app.useGlobalPipes(new ValidationPipe({ transform: true }));

  // CORS — the same allowlist the websocket gateways use.
  app.enableCors({ origin: corsOriginDelegate, credentials: true });

  // Swagger configuration
  const config = new DocumentBuilder()
    .setTitle('Flui.cloud API')
    .setDescription('API documentation Flui.cloud')
    .setVersion('1.0')
    .addBearerAuth()
    .build();

  const document = addEnumVarnamesExtension(
    SwaggerModule.createDocument(app, config),
  );

  SwaggerModule.setup('docs/internal', app, document, {
    jsonDocumentUrl: 'swagger/json',
  });

  // Public API docs with filtered endpoints
  const publicDocument = addEnumVarnamesExtension(
    SwaggerModule.createDocument(app, config, {
      include: [], // We'll add public modules here later
    }),
  );
  SwaggerModule.setup('docs/public', app, publicDocument);
  // Order matters: Nest tries the LAST-registered filter first, and the two
  // catch disjoint types anyway — `HttpException` and `QueryFailedError`. Both
  // are listed in one call so a reader sees the whole set in one place.
  app.useGlobalFilters(
    new HttpExceptionFilter(),
    new MalformedIdentifierFilter(),
  );
  await app.listen(process.env.PORT || 3000);
}
bootstrap();
