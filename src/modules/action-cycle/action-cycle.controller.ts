import {
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { ActionCycleService } from './action-cycle.service';
import { DecideProposalDto } from './dto/decide-proposal.dto';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { actorFromRequest } from '../auth/utils/actor.util';
import { RequestWithApiKey } from '../auth/strategies/api-key.strategy';

export const AGENT_MAY_NOT_DECIDE_CODE = 'AGENT_MAY_NOT_DECIDE';

/**
 * The routes a person answers a request on, and manages what they have already
 * allowed.
 *
 * Three properties of this controller are load-bearing:
 *
 *  - **an agent cannot answer its own request.** An agent credential is issued
 *    *as* its principal, so without this line the applicant holds the
 *    approver's pen and the whole cycle is a formality it performs on itself.
 *    The refusal is on the actor kind — the credential's ceiling, or the
 *    agentic surface the call came through — and not on a permission, because
 *    the person's permissions are exactly what the agent is carrying. It is
 *    also what keeps the portal's assistant on the applicant's side of the
 *    table: a chat answering its own request is refused here, while the same
 *    person answering from the dashboard is not;
 *  - **no `@RequireSection`.** A sandbox guest holds no section at all beyond
 *    its own things, and a request it cannot answer is a request that stops the
 *    trial dead. These routes are also listed in the fence's "own" set for the
 *    same reason: deciding is a write, and the read-only third state of a
 *    section does not reach it;
 *  - **ownership, not authority.** A request is addressed to somebody. Holding
 *    the whole instance is not standing to answer a question asked of another
 *    person, so every read and write here is filtered by `ownerUserId` and a
 *    row belonging to somebody else answers 404, not 403.
 */
@ApiTags('Agent - Action cycle')
@ApiBearerAuth()
@Controller('agent')
export class ActionCycleController {
  constructor(private readonly cycle: ActionCycleService) {}

  @Get('proposals')
  @ApiOperation({
    summary: 'Requests your agents have raised and are waiting on you',
  })
  async listProposals(@Req() req: Request, @Query('status') status?: string) {
    return this.cycle.listProposals(this.userId(req), status);
  }

  @Get('proposals/:id')
  @ApiOperation({ summary: 'One request, with what "always" would concede' })
  async getProposal(@Req() req: Request, @Param('id') id: string) {
    return this.cycle.ownProposal(id, this.userId(req));
  }

  @Post('proposals/:id/decide')
  @ApiOperation({
    summary: 'Answer a request: once, always, or no',
    description:
      'The agent is not told directly. It learns the answer by retrying the ' +
      'identical call, which is what makes the wait a state rather than a held ' +
      'connection — and what keeps the attribution honest: the operation is ' +
      "started by the agent's credential under a named permission, not by a click.",
  })
  async decide(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: DecideProposalDto,
  ) {
    this.refuseAgents(req);
    const { proposal, concession } = await this.cycle.decideProposal(
      id,
      this.userId(req),
      dto.decision,
    );
    return { proposal, concession: concession ?? null };
  }

  @Get('concessions')
  @ApiOperation({ summary: 'What your agents may do without asking' })
  async listConcessions(@Req() req: Request) {
    return this.cycle.listConcessions(this.userId(req));
  }

  @Get('concessions/:id/operations')
  @ApiOperation({
    summary: 'What is still running under this concession',
    description:
      'The revoke dialog asks for this first. Revoking stops future departures ' +
      'at once and does not abort what has already left, so a person deciding to ' +
      'take a permission back is entitled to see what continues either way.',
  })
  async runningUnder(@Req() req: Request, @Param('id') id: string) {
    await this.cycle.ownConcession(id, this.userId(req));
    const running = await this.cycle.runningUnder(id);
    return running.map((operation) => ({
      id: operation.id,
      operationType: operation.operationType,
      status: operation.status,
      progress: operation.progress,
      resourceName: operation.resourceName,
      startedAt: operation.startedAt,
    }));
  }

  @Delete('concessions/:id')
  @ApiOperation({
    summary: 'Take a standing permission back',
    description:
      'Immediate and total for anything that has not started. Pass stop=true to ' +
      'also ask the operations already running under it to stop at their next ' +
      'step boundary — never mid-step, because a provisioning cut in half leaves ' +
      'paid-for resources orphaned.',
  })
  async revoke(
    @Req() req: Request,
    @Param('id') id: string,
    @Query('stop') stop?: string,
  ) {
    this.refuseAgents(req);
    return this.cycle.revoke(id, this.userId(req), stop === 'true');
  }

  private userId(req: Request): string {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Unauthenticated');
    return user.userId;
  }

  /**
   * The line without which the cycle decides nothing.
   *
   * An agent presents its principal's own credential, so every permission check
   * on this route would pass. What separates the applicant from the approver
   * here is not what the credential may do — it is what it *is*, read off the
   * `mcp:*` ceiling and off the surface the call came through, never off
   * anything the caller says about itself.
   *
   * The assistant's own in-chat "yes" reaches this route deliberately on a
   * caller that declares **no** surface: it is the person answering, not their
   * copilot, and a caller that got that wrong would be refused right here.
   */
  private refuseAgents(req: Request): void {
    const actor = actorFromRequest(req as Request & RequestWithApiKey);
    if (actor.kind !== 'agent') return;
    throw new ForbiddenException({
      statusCode: 403,
      code: AGENT_MAY_NOT_DECIDE_CODE,
      message:
        'An agent credential cannot answer its own request. Ask the person you act ' +
        'for to allow it — you will find out by retrying the original call. Do not ' +
        'retry this one.',
    });
  }
}
