import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';
import { DbConnectionInfo } from '../interfaces/db-connection';

/**
 * `DbConnectionInfo` wrapped as a real DTO class, same reason as
 * `IdentityUserResponseDto`: a plain interface has no metadata for the
 * sentinel or the interceptor to find, so nothing could see that `namespace`
 * feeds a cluster-internal hostname. Shape and classification only.
 */
export class DbConnectionInfoResponseDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Database engine, e.g. "postgres".',
  })
  engine: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Database name.' })
  database: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Connecting role/user name.' })
  user: string;

  // The dashboard composes this into a cluster-internal DNS name it never
  // receives pre-composed from here, so it reveals cluster addressing the
  // same way an instance IP does.
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  @ApiProperty({
    description:
      'Kubernetes namespace the database Service lives in. Composed by the ' +
      'dashboard into the in-cluster DNS name `<slug>-svc.<namespace>.svc.cluster.local`.',
  })
  namespace: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Label selector matching the database pod, for tunneling.',
  })
  podLabelSelector: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Cluster ID the database runs on.' })
  clusterId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'Remote port the database listens on.' })
  remotePort: number;

  constructor(info: DbConnectionInfo) {
    this.engine = info.engine;
    this.database = info.database;
    this.user = info.user;
    this.namespace = info.namespace;
    this.podLabelSelector = info.podLabelSelector;
    this.clusterId = info.clusterId;
    this.remotePort = info.remotePort;
  }
}
