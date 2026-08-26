import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Query,
  Req,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { Request } from 'express';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { AgentActivityService } from './agent-activity.service';
import {
  AgentActivityEntryDto,
  AgentActivityPageDto,
  AgentActivityQueryDto,
  AgentIdentityActivityPageDto,
  AgentIdentityActivityQueryDto,
} from './dto/agent-activity.dto';

/**
 * "What it did" — the third section of the agent panel, and the one the table
 * had no door onto.
 *
 * `mcp_tool_call_logs` has been written on every tool call since the MCP
 * surface existed and read by nothing: the six columns the actor pass added are
 * only worth having if somebody can see them. This is that reading, and three
 * decisions in it are load-bearing:
 *
 *  - **it sits on `/agent`, beside the cycle.** The panel asks four questions
 *    of one subject, and answering the fourth from a different noun would make
 *    a client assemble the section out of two vocabularies;
 *  - **no `@RequirePermission`, and no `@RequireSection`.** Not an omission —
 *    the same decision `GET /auth/api-keys` and `GET /agent/proposals` already
 *    embody. Every caller may read *their own* register, including a sandbox
 *    guest who holds no section at all, and a person who cannot see what the
 *    agent they connected has been doing cannot decide whether to disconnect
 *    it. Widening past one's own rows is not free, and is decided inside the
 *    handler by {@link activityReach}, which asks the credential's ceiling and
 *    then IAM — in that order, because a key is issued *as* its principal and
 *    asking IAM first would hand every administrator's agent key the whole
 *    instance;
 *  - **absence, not refusal.** Somebody else's row answers 404 and somebody
 *    else's page answers empty. A register that says "forbidden" has confirmed
 *    that the call it is hiding took place.
 */
@ApiTags('Agent - Activity')
@ApiBearerAuth()
@Controller('agent')
export class AgentActivityController {
  constructor(private readonly activity: AgentActivityService) {}

  @Get('activity')
  @ApiOperation({
    summary: 'What has been done through the tools, newest first',
    description:
      'Your own calls, or the whole instance for a caller who administers ' +
      'access — `scope` in the answer says which one you got. Arguments come ' +
      'back as they were stored: closed-set values verbatim, everything else ' +
      'withheld. Which resource a call touched is not in the arguments and is ' +
      'not meant to be — follow `operation` for that, which the server wrote ' +
      'itself. `error` obeys the same discipline for the same reason: it is a ' +
      'string built downstream by concatenation, so it comes back verbatim ' +
      'only to a reader entitled to the full diagnosis. Pass `proposalId` to ' +
      'ask the other way round — what a request you answered actually ' +
      'authorised.',
  })
  @ApiOkResponse({ type: AgentActivityPageDto })
  page(
    @Req() req: Request,
    @Query() query: AgentActivityQueryDto,
  ): Promise<AgentActivityPageDto> {
    return this.activity.page(this.userOf(req), query);
  }

  /**
   * Declared before `:id` on purpose — Nest matches in declaration order, and
   * the other way round this path would be parsed as an id and answer 400.
   */
  @Get('activity/identities')
  @ApiOperation({
    summary: 'Every credential that has acted, and when it last did',
    description:
      'The "last activity" the panel shows beside a connected agent, derived ' +
      'from the register rather than kept in a column. It is not ' +
      '`lastUsedAt` on the key: that one says when the credential last ' +
      'authenticated, so a key that connected and did nothing is recent there ' +
      'and silent here. Both are returned, so the difference is visible.',
  })
  @ApiOkResponse({ type: AgentIdentityActivityPageDto })
  identities(
    @Req() req: Request,
    @Query() query: AgentIdentityActivityQueryDto,
  ): Promise<AgentIdentityActivityPageDto> {
    return this.activity.identities(this.userOf(req), query);
  }

  @Get('activity/:id')
  @ApiOperation({
    summary: 'One call, with the operation it started',
    description: "Somebody else's answers 404, not 403.",
  })
  @ApiOkResponse({ type: AgentActivityEntryDto })
  entry(
    @Req() req: Request,
    @Param('id', ParseUUIDPipe) id: string,
  ): Promise<AgentActivityEntryDto> {
    return this.activity.entry(this.userOf(req), id);
  }

  private userOf(req: Request): AuthenticatedUser {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) throw new ForbiddenException('Unauthenticated');
    return user;
  }
}
