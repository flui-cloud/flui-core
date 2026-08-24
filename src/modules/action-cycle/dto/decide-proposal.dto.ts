import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';
import { PROPOSAL_DECISION, ProposalDecision } from '../action-cycle.core';

export class DecideProposalDto {
  @ApiProperty({
    enum: Object.values(PROPOSAL_DECISION),
    description:
      'once — let this call through and keep nothing; always — let it through and ' +
      'record a standing concession for this exact shape and resource; deny — refuse it.',
  })
  @IsIn(Object.values(PROPOSAL_DECISION))
  decision: ProposalDecision;
}
