import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';
import { OperationStatus } from '../../servers/entities/infrastructure-operations.entity';

/** A piece of a node's install log, read from a cursor onwards. */
export class InstallLogChunkDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: '9e5b17a1-730d-460b-9842-69320435b6e0' })
  operationId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: OperationStatus,
    description: 'Status of the operation that installs the node.',
  })
  status: OperationStatus;

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'The log from `since` up to `next`, as captured from the node. Empty when nothing new was captured.',
    example: 'Cloud-init v. 24.1 running...\n',
  })
  text: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Where this piece starts. Equal to the `since` asked for, or to the end of the log when the cursor asked for was past it.',
    example: 0,
  })
  since: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'The cursor to send as `since` on the next read. The log only grows, so a cursor stays valid while the node keeps writing.',
    example: 4210,
  })
  next: number;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'More of the log is already captured past `next`: read again straight away instead of waiting.',
  })
  more: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description: 'Whether anything was captured for this operation at all.',
  })
  captured: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'The log reached its size limit and later output was not kept.',
  })
  truncated: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    description:
      'Nothing more will arrive: the operation has finished and this read reached the end of the log. Stop reading when true.',
  })
  done: boolean;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Why the log is empty or incomplete, in words to show as they are. Null when there is nothing to explain.',
  })
  note: string | null;
}
