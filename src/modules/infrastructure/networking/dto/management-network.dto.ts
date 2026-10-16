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

export class ManagementNetworkHubNodeDto extends ManagementNetworkHubDto {
  @ApiProperty({
    nullable: true,
    description: 'The control node this end runs on',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  nodeId: string | null;

  @ApiProperty({ nullable: true })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  nodeName: string | null;

  @ApiProperty({
    description:
      'The master: its key is kept for a rebuild, and telemetry is sent to its address',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  primary: boolean;

  @ApiProperty({
    enum: ['pending', 'active', 'stale'],
    description:
      '`active`: its config applied and its tunnel state was read on the last pass',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  status: 'pending' | 'active' | 'stale';

  @ApiProperty({
    description: 'Members this control node saw a recent handshake from',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  membersReached: number;

  @ApiProperty({
    description: 'Members it has not seen recently, or never',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  membersNotReached: number;
}

export class OverlayDemotionDto {
  @ApiProperty()
  @Sensitivity(Sensitivity.PUBLIC)
  clusterId: string;

  @ApiProperty()
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  clusterName: string;

  @ApiProperty({ nullable: true, description: 'The API address it had' })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  from: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The public API address now stored',
  })
  @Sensitivity(Sensitivity.NETWORK_IDENTIFIER)
  to: string | null;

  @ApiProperty({ description: 'Whether the stored address changed' })
  @Sensitivity(Sensitivity.PUBLIC)
  changed: boolean;

  @ApiProperty({
    description: 'Whether the cluster is held off the Flui network',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  held: boolean;
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

  @ApiProperty({
    nullable: true,
    description:
      'Control nodes whose end is up and that have not seen this member recently: what moving the cluster onto the Flui network waits on. Empty when every one reaches it, null when unknown',
    type: [String],
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  unreachedFrom: string[] | null;

  @ApiProperty({
    description:
      'The cluster is held on its public address by a person, off the Flui network',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  heldOffOverlay: boolean;
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

  @ApiProperty({
    type: ManagementNetworkHubDto,
    nullable: true,
    deprecated: true,
    description: 'The primary control end; read `hubs` for every control node',
  })
  hub: ManagementNetworkHubDto | null;

  @ApiProperty({
    type: [ManagementNetworkHubNodeDto],
    description: 'One end per control node, the primary first',
  })
  hubs: ManagementNetworkHubNodeDto[];

  @ApiProperty({
    nullable: true,
    description:
      "Why the control's end could not be set up on the last attempt (members stay pending until it is); null once it applies",
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  hubProblem: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Something about the control end that works but is set up wrong, such as a declared endpoint name that does not lead to the control master alone; null when nothing is',
  })
  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  hubWarning: string | null;

  @ApiProperty({ type: [ManagementNetworkMemberDto] })
  members: ManagementNetworkMemberDto[];
}
