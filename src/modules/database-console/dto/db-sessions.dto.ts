import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches, MaxLength } from 'class-validator';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export const SESSION_KINDS = [
  'client',
  'pooler',
  'local',
  'replication',
  'background',
] as const;
export type DbSessionKind = (typeof SESSION_KINDS)[number];

export const SESSION_VIAS = ['pooler', 'direct', 'socket'] as const;
export type DbSessionVia = (typeof SESSION_VIAS)[number];

export const BACKEND_START_PATTERN =
  /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,6})?(?:Z|[+-]\d\d:?\d\d)$/;

export class DbSessionAppRefDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;
}

export class DbSessionActionsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The running statement can be cancelled' })
  cancel: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The session can be closed' })
  terminate: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Why an action is off, in words a person can act on',
  })
  reason: string | null;
}

export class DbSessionDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  pid: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'When the session started, to the millisecond. Sent back with cancel or terminate so a reused pid is never hit.',
  })
  backendStart: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: SESSION_KINDS })
  kind: DbSessionKind;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: SESSION_VIAS })
  via: DbSessionVia;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  user: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  database: string;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  applicationName: string;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({ nullable: true, type: String })
  clientAddr: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbSessionAppRefDto, nullable: true })
  clientApp: DbSessionAppRefDto | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  state: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  waitEventType: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  waitEvent: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  xactAgeMs: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  queryAgeMs: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  stateAgeMs: number | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The session holds a transaction id: it wrote' })
  writing: boolean;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'The last statement with every literal replaced by ?, comments removed',
  })
  query: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [Number], description: 'Sessions this one waits for' })
  blockedBy: number[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'How many sessions wait for this one' })
  blocks: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbSessionActionsDto })
  actions: DbSessionActionsDto;
}

export class DbSessionCountsDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  active: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  idle: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  idleInTransaction: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Running statements waiting on a lock, I/O or the server',
  })
  waiting: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Sessions waiting for another session' })
  blocked: number;
}

export class DbPoolerPoolDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  pod: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  database: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  user: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  clientsActive: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  clientsWaiting: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  serversActive: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  serversIdle: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  maxWaitMs: number;
}

export class DbPoolerClientDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  pod: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  id: number;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty()
  addr: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbSessionAppRefDto, nullable: true })
  clientApp: DbSessionAppRefDto | null;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  user: string;

  @Sensitivity(Sensitivity.TENANT_IDENTITY)
  @ApiProperty()
  database: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  state: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  waitMs: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: Number })
  serverPid: number | null;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty()
  applicationName: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  connectTime: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  canClose: boolean;
}

export class DbPoolerViewDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['transaction', 'session'] })
  mode: 'transaction' | 'session';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  paused: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['local', 'forward'] })
  upstream: 'local' | 'forward';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Why the pooler could not be read, when it could not',
  })
  reason: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbPoolerPoolDto, isArray: true })
  pools: DbPoolerPoolDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbPoolerClientDto, isArray: true })
  clients: DbPoolerClientDto[];
}

export class DbSessionsResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['postgres'] })
  engine: 'postgres';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Read on the database clock' })
  capturedAt: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'More sessions exist than were returned' })
  truncated: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  maxConnections: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Connected sessions, idle ones included' })
  total: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbSessionCountsDto })
  counts: DbSessionCountsDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbSessionDto, isArray: true })
  sessions: DbSessionDto[];

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: () => DbPoolerViewDto, nullable: true })
  pooler: DbPoolerViewDto | null;
}

export class DbSessionActionDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'backendStart of the session, as the list returned it',
  })
  @IsString()
  @Matches(BACKEND_START_PATTERN, {
    message: 'backendStart must be the ISO timestamp the session list returned',
  })
  backendStart: string;
}

export class DbSessionActionResultDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  pid: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['cancel', 'terminate'] })
  action: 'cancel' | 'terminate';

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'What happened, in one sentence' })
  message: string;
}

export class DbPoolerClientCloseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Pooler pod holding the client, as listed' })
  @IsString()
  @Matches(/^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/, {
    message: 'pod must be a pod name the session list returned',
  })
  pod: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'connectTime of the client, as listed' })
  @IsString()
  @MaxLength(64)
  connectTime: string;
}

export class DbPoolerClientCloseResultDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  clientId: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  pod: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'What happened, in one sentence' })
  message: string;
}
