import { ApiProperty } from '@nestjs/swagger';

export class InventoryNodeDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ description: 'master or worker' })
  type: string;

  @ApiProperty({ nullable: true })
  publicIp: string | null;

  @ApiProperty({ nullable: true })
  privateIp: string | null;

  @ApiProperty()
  status: string;
}

/**
 * Everything a CLI needs to rebuild its local view of a cluster it did not
 * create — and nothing more.
 *
 * This is the customer's side of the managed handoff: `flui env adopt` asks the
 * installation to describe itself, instead of a bundle of state being shipped
 * from app.flui.cloud. The cluster is the authority for its own inventory, so
 * the answer is always current, and the managed plane never has to hold it.
 *
 * Deliberately absent: kubeconfig, CA material, provider credentials, secrets.
 * Adopting gives you the map, not the keys — those you generate yourself.
 */
export class ClusterInventoryDto {
  @ApiProperty()
  clusterId: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  provider: string;

  @ApiProperty()
  region: string;

  @ApiProperty()
  status: string;

  @ApiProperty({ type: [InventoryNodeDto] })
  nodes: InventoryNodeDto[];

  @ApiProperty({
    nullable: true,
    description: 'Where this installation answers.',
  })
  endpoint: string | null;

  @ApiProperty({ description: 'Platform release this installation runs.' })
  version: string;

  @ApiProperty({
    description:
      'True when the SSH CA public key is already trusted by the nodes, i.e. this installation has been adopted before.',
  })
  sshCaEnrolled: boolean;
}
