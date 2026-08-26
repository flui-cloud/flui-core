import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Patch,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request } from 'express';
import { OperatingContextService } from './operating-context.service';
import {
  EditContextEntryDto,
  WriteContextEntryDto,
} from './dto/operating-context.dto';
import { RequirePermission } from '../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../iam/constants/iam-permissions';
import { principalOf, ResourceAttributes } from '../iam/interfaces/iam.types';
import { ActionCycle } from '../action-cycle/action-cycle.decorator';
import { reachClauseOf } from './operating-context.reach';

/**
 * The operating context: what this installation has decided about how it is
 * run, and where each decision applies.
 *
 * Three properties are load-bearing here:
 *
 *  - **the route permissions are coarse and the service is the gate.** The
 *    decorators name `app:read` / `app:write` because a body of advice must not
 *    mint a permission of its own — that is how a second authorization system
 *    starts. What decides is the covering check inside the service, in the same
 *    two-halves shape the destructive routes already use: the permission the
 *    credential ceiling can read, and the assertion that actually answers;
 *  - **no `@RequireSection`.** These notes are not a management screen. A
 *    tenant reading the rules of the cluster their application sits on is the
 *    entire point of the feature, and a section gate would hand the advice back
 *    to exactly the people who already know it;
 *  - **an agent proposes, it does not decide.** The three writes carry
 *    `@ActionCycle`, so a model that concludes a rule should change gets a
 *    person's answer first. Reading needs no such thing — reading is the
 *    delivery this whole feature exists for.
 */
@ApiTags('Operating context')
@ApiBearerAuth()
@Controller('operating-context')
export class OperatingContextController {
  constructor(private readonly context: OperatingContextService) {}

  @Get()
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'The notes that reach you, each with its own verdict on itself',
  })
  list(@Req() req: Request, @Query() query: Record<string, string>) {
    return this.context.list(principalOf(req), focusOf(query));
  }

  @Get('advice')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'The same notes shaped for a reader about to act',
    description:
      'Advice, what is asking to be revisited, and the disagreements — shown, never resolved.',
  })
  advice(@Req() req: Request, @Query() query: Record<string, string>) {
    return this.context.advice(principalOf(req), focusOf(query));
  }

  /**
   * The notes that were retired, and when.
   *
   * `DELETE` archives rather than deletes, and until this existed nothing ever
   * read `archivedAt` back: a note withdrawn from the dashboard was gone for
   * good, which makes archiving deletion with more steps and a false promise of
   * history. Read by whoever the note reached while it stood, and — this is the
   * part that matters — reachable **only** here: it is not in the list, so it
   * cannot reach `advice`, so no agent is ever handed a rule somebody withdrew.
   */
  @Get('archive')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'The notes that were retired, with the day each was withdrawn',
    description:
      'Why it used to be done this way. Never delivered as advice, to anyone.',
  })
  retired(@Req() req: Request, @Query() query: Record<string, string>) {
    return this.context.retired(principalOf(req), focusOf(query));
  }

  @Get('probes')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({ summary: 'The live facts a note can be made to lean on' })
  probes() {
    return this.context.probeCatalog();
  }

  /**
   * Deliberately a read and deliberately not gated on being able to write here.
   *
   * It is an occasion to notice, not a filter: the answer is a pure function of
   * the two words the caller supplied, so it discloses nothing, and refusing to
   * say who a level reaches until somebody has proved they may write at it
   * would withhold the warning from exactly the person deciding which level to
   * ask for.
   */
  @Get('reach')
  @RequirePermission(IAM_PERMISSION.APP_READ)
  @ApiOperation({
    summary: 'Who a note at this level would reach, before you write it',
    description:
      'The same line a saved note carries, so a form, the CLI and a re-reading cannot disagree.',
  })
  reach(@Query() query: Record<string, string>) {
    return this.context.reachFor(query.scopeType, query.nature, query.scopeRef);
  }

  @Post()
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  /**
   * The only one of the four writes whose sentence can say who will read the
   * note: the level is in the body here, and on the other three it belongs to a
   * note that already exists — which the guard would have to read the table to
   * find out, and a guard that reads the domain to phrase a question fails for
   * reasons that have nothing to do with the decision.
   */
  @ActionCycle({
    action: 'POST /operating-context',
    sentence: 'write a new operating-context note',
    clause: reachClauseOf,
  })
  @ApiOperation({ summary: 'Write a note at a level you cover' })
  create(@Req() req: Request, @Body() dto: WriteContextEntryDto) {
    return this.context.create(principalOf(req), dto);
  }

  @Patch(':id')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'PATCH /operating-context/:id',
    bind: ['id'],
    sentence: 'reword operating-context note {id}',
  })
  @ApiOperation({ summary: 'Reword a note. Its level never moves.' })
  edit(
    @Req() req: Request,
    @Param('id') id: string,
    @Body() dto: EditContextEntryDto,
  ) {
    return this.context.edit(principalOf(req), id, dto);
  }

  @Post(':id/confirm')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'POST /operating-context/:id/confirm',
    bind: ['id'],
    sentence: 'confirm operating-context note {id} is still true',
  })
  @ApiOperation({ summary: 'Put your name to an attested note again' })
  confirm(@Req() req: Request, @Param('id') id: string) {
    return this.context.confirm(principalOf(req), id);
  }

  @Delete(':id')
  @RequirePermission(IAM_PERMISSION.APP_WRITE)
  @ActionCycle({
    action: 'DELETE /operating-context/:id',
    bind: ['id'],
    sentence: 'retire operating-context note {id}',
  })
  @ApiOperation({
    summary: 'Retire a note. It is archived, never deleted.',
    description:
      'A rule that was true once explains a decision that was made once.',
  })
  archive(@Req() req: Request, @Param('id') id: string) {
    return this.context.archive(principalOf(req), id);
  }
}

/**
 * What the caller is about to act on, if they said.
 *
 * Written as `ResourceAttributes` — the same shape the fence evaluates a grant
 * against — so "which notes apply here" and "may you touch this" are asked of
 * one description of the resource rather than two.
 */
function focusOf(
  query: Record<string, string>,
): ResourceAttributes | undefined {
  const focus: ResourceAttributes = {
    slug: query.slug,
    clusterId: query.clusterId,
    clusterName: query.clusterName,
    provider: query.provider,
    project: query.project,
    kind: query.kind,
    owner: query.owner,
    tags: query.tags ? query.tags.split(',') : undefined,
  };
  return Object.values(focus).some((v) => v !== undefined) ? focus : undefined;
}
