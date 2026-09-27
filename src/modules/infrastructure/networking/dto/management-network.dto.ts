import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';

export class SetManagementNetworkDto {
  @ApiProperty({
    description: 'Switch the Flui network on or off for this installation',
  })
  @IsBoolean()
  enabled: boolean;
}

export class ManagementNetworkHubDto {
  @ApiProperty({ description: 'Address of the control on the Flui network' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  address: string;

  @ApiProperty({
    nullable: true,
    description: 'Where members dial in, host:port',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  endpoint: string | null;

  @ApiProperty({ description: 'Whether the control has presented its key' })
  @Sensitivity(Sensitivity.PUBLIC)
  keyed: boolean;
}

export class ManagementNetworkMemberDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  clusterName: string;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  nodeName: string | null;

  @ApiProperty({ description: 'Address of the node on the Flui network' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  address: string;

  @ApiProperty({ enum: ['pending', 'active', 'stale'] })
  @Sensitivity(Sensitivity.PUBLIC)
  status: 'pending' | 'active' | 'stale';

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.PUBLIC)
  lastHandshakeAt: string | null;
}

export class ManagementNetworkDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  enabled: boolean;

  @ApiProperty({
    enum: ['setting', 'install', 'default'],
    description:
      '`setting`: switched from the dashboard, CLI or an agent; `install`: chosen when the installation was made; `default`: on, nobody chose otherwise',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  source: 'setting' | 'install' | 'default';

  @ApiProperty({
    nullable: true,
    description:
      'Why the Flui network cannot work here, or null when nothing stands in the way',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  unavailable: string | null;

  @ApiProperty({ type: ManagementNetworkHubDto, nullable: true })
  hub: ManagementNetworkHubDto | null;

  @ApiProperty({ type: [ManagementNetworkMemberDto] })
  members: ManagementNetworkMemberDto[];
}
