import { Injectable } from '@nestjs/common';
import { DbEngine } from '../interfaces/db-connection';
import { profileForEngine } from '../engine/engine-profile';
import { SqlKb } from './kb.types';
/* eslint-disable @typescript-eslint/no-require-imports */
import postgresKb = require('./dist/postgres.kb.json');
import mariadbKb = require('./dist/mariadb.kb.json');
import redisKb = require('./dist/redis.kb.json');
/* eslint-enable @typescript-eslint/no-require-imports */

// Redis and Valkey share one curated corpus (same protocol/commands).
const KBS: Record<DbEngine, SqlKb> = {
  postgres: postgresKb as unknown as SqlKb,
  mariadb: mariadbKb as unknown as SqlKb,
  redis: redisKb as unknown as SqlKb,
  valkey: redisKb as unknown as SqlKb,
};

/**
 * Serves the baked copilot knowledge bases, one curated corpus per engine (SQL dialects and the
 * Redis/Valkey command set). Each corpus is small and version-agnostic, so it is injected WHOLE
 * (no router): the engine's guardrails + its dialect/command sections. Version awareness comes
 * from a one-line binding stamped with the live server version.
 *
 * Data-blind by contract: this context carries schema/keyspace summary + KB only — never rows/values.
 */
@Injectable()
export class EngineKnowledgeService {
  getSystemContext(engine: DbEngine, serverVersion?: string): string {
    const kb = KBS[engine];
    const profile = profileForEngine(engine);
    const corpus = kb.sections
      .map((s) => `## ${s.title}\n_(${s.id})_\n\n${s.body}`)
      .join('\n\n');
    return [
      kb.guardrails,
      this.binding(profile.label, profile.dialect, serverVersion),
      `# ${profile.label} knowledge`,
      corpus,
    ].join('\n\n');
  }

  getInfo(engine: DbEngine): {
    dialect: string;
    kbVersion: string;
    sections: number;
  } {
    const kb = KBS[engine];
    return {
      dialect: kb.dialect,
      kbVersion: kb.kbVersion,
      sections: kb.sections.length,
    };
  }

  private binding(
    label: string,
    dialect: string,
    serverVersion?: string,
  ): string {
    const target = serverVersion
      ? `${label} ${serverVersion}`
      : `${label} (version unknown)`;
    return [
      '# Target database',
      `- Engine: ${target}`,
      `- Dialect: ${dialect}`,
      '- Only features available in the target version are valid; when unsure, prefer widely-supported syntax.',
    ].join('\n');
  }
}
