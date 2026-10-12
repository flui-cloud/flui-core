import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class DbPoolerAddressesDto {
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'In-cluster host:port of the pooler, what FLUI_CONNECTION_URL names once `routed` is true. Null without a pooler.',
    example: 'postgresql-ab12-pooler.user-x.svc.cluster.local:5432',
  })
  pooled: string | null;

  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER, { screenOnly: true })
  @ApiProperty({
    description:
      'In-cluster host:port of the database itself, what FLUI_DIRECT_URL names: for schema migrations, LISTEN/NOTIFY, session advisory locks and admin tools.',
    example: 'postgresql-ab12-svc.user-x.svc.cluster.local:5432',
  })
  direct: string;
}

export class DbPoolerPodDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  name: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  ready: boolean;
}

export class DbPoolerStatusDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Whether the database has a connection pooler. Chosen at install; installs made before the pooler existed have none.',
  })
  enabled: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['transaction', 'session'],
    nullable: true,
    description:
      '`transaction`: a server connection per transaction, the most sharing. `session`: one per client, for LISTEN/NOTIFY, session advisory locks or session SET.',
  })
  mode: 'transaction' | 'session' | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty()
  replicas: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  image: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ enum: ['local', 'forward'], nullable: true })
  upstream: 'local' | 'forward' | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'True when FLUI_CONNECTION_URL goes through the pooler. False while it is being set up, or when it did not become ready (see `reason`): apps then connect directly.',
  })
  routed: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'Why the pooler is not carrying the connection URL.',
  })
  reason: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: DbPoolerAddressesDto })
  addresses: DbPoolerAddressesDto;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [DbPoolerPodDto] })
  pods: DbPoolerPodDto[];
}
