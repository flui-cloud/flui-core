import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Put,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { RequirePermission } from '../../iam/decorators/require-permission.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { PublishShowcaseDto } from '../dto/publish-showcase.dto';
import { ShowcaseItemDto } from '../dto/showcase-item.dto';
import { ShowcaseService } from '../services/showcase.service';

/**
 * The showcase: the applications this instance chooses to show everyone.
 *
 * Reading it is not the same as reading applications. The shape here is fixed
 * and small — name, what it is, since when, where it answers — and it carries
 * nothing an application record carries: no environment, no cluster, no
 * namespace, no owner. That is deliberate. A showcase is the one read that
 * crosses from the operator's things to somebody else's screen, so what it
 * shows has to be a decision rather than a filter over a wider query that
 * somebody might widen later.
 */
@ApiTags('Showcase')
@ApiBearerAuth()
@Controller('showcase')
export class ShowcaseController {
  constructor(private readonly showcase: ShowcaseService) {}

  @Get()
  @ApiOperation({
    summary: 'The applications published to the showcase',
    description:
      'The applications carrying the `showcase` tag — the same tag the showcase grant selects on, so this list and what a principal is allowed to read cannot drift apart. Oldest first, because how long something has been running is the claim the showcase makes. Empty until somebody tags one: nothing lands in it by inference.',
  })
  @ApiResponse({ status: 200, type: ShowcaseItemDto, isArray: true })
  list(): Promise<ShowcaseItemDto[]> {
    return this.showcase.list();
  }

  @Put(':ref')
  @RequirePermission(IAM_PERMISSION.SHOWCASE_PUBLISH)
  @ApiOperation({
    summary: 'Publish one application to the showcase',
    description:
      'Adds the `showcase` tag, and sets the description when a line is given. Accepts a slug, a name or an id. Publishing something already in the showcase only rewrites the line.',
  })
  @ApiParam({ name: 'ref', description: 'Application slug, name or id' })
  @ApiResponse({ status: 200, type: ShowcaseItemDto })
  @ApiResponse({ status: 404, description: 'No such application' })
  async publish(
    @Param('ref') ref: string,
    @Body() dto: PublishShowcaseDto,
  ): Promise<ShowcaseItemDto> {
    const application = await this.showcase.resolve(ref);
    return this.showcase.publish(application.id, dto.note);
  }

  @Delete(':ref')
  @RequirePermission(IAM_PERMISSION.SHOWCASE_PUBLISH)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({
    summary: 'Take one application out of the showcase',
    description:
      'Removes the tag. The application keeps running and keeps its owner; only who may see it changes.',
  })
  @ApiParam({ name: 'ref', description: 'Application slug, name or id' })
  @ApiResponse({ status: 204, description: 'No longer in the showcase' })
  async withdraw(@Param('ref') ref: string): Promise<void> {
    const application = await this.showcase.resolve(ref);
    await this.showcase.withdraw(application.id);
  }
}
