import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../mask/decorators/sensitivity.decorator';

export class AppUdpPortStatusDto {
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() name: string;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() port: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['open', 'pending', 'closed', 'unmanaged', 'not-published'],
    description:
      'open: a cluster firewall rule lets it in. pending: the rule is saved but not applied yet. closed: no rule opens it. unmanaged: the cluster has no firewall Flui manages. not-published: trial apps never get a public UDP port.',
  })
  state: 'open' | 'pending' | 'closed' | 'unmanaged' | 'not-published';
}

export class AppUdpPortsDto {
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() applicationId: string;
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() clusterId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description: 'The cluster firewall where the ports are opened.',
  })
  firewallId: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [AppUdpPortStatusDto] })
  ports: AppUdpPortStatusDto[];
}

export class UdpPortPreviewDto extends AppUdpPortStatusDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    nullable: true,
    type: String,
    description:
      'The app on this cluster that already holds the port. The install is refused while it does.',
  })
  takenBy: string | null;
}

export class CatalogUdpPortsPreviewDto {
  @Sensitivity(Sensitivity.PUBLIC) @ApiProperty() clusterId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true, type: String })
  firewallId: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: [UdpPortPreviewDto] })
  ports: UdpPortPreviewDto[];
}
