import {
  ConflictException,
  Controller,
  Get,
  NotFoundException,
  Param,
  ParseEnumPipe,
  ParseIntPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import { CrashDiagnosesRepository } from '../repositories/crash-diagnoses.repository';
import { CrashDiagnosisDto } from '../dto/crash-diagnosis.dto';
import { CrashDiagnosisEntity } from '../entities/crash-diagnosis.entity';
import { CrashDiagnosisStatusFilter } from '../enums/crash-diagnosis-status-filter.enum';
import { AppAccessGuard } from '../../applications/guards/app-access.guard';
import { AppManagementService } from '../../applications/services/app-management.service';
import { UpdateResourcesDto } from '../../applications/dto/app-management.dto';
import { SuggestedActionType } from '../enums/suggested-action-type.enum';

/**
 * The crash history of one application, and the gestures that dismiss an
 * entry or accept what it proposes.
 *
 * Guarded on the class for the same reason as PodDebugController: every route
 * here names an application in the path, and the diagnosis text quotes the
 * container's own error output.
 *
 * The application is `:id`, like everywhere else. That forced the
 * nested parameter to stop being `:id` too: two path parameters of the same
 * name collide, Express keeps the last, and `AppAccessGuard` would have been
 * handed the diagnosis id to check ownership on. It is `:diagnosisId` now, and
 * it names what it is.
 */
@ApiTags('applications')
@ApiBearerAuth()
@UseGuards(AppAccessGuard)
@Controller('applications/:id/crash-diagnoses')
export class CrashDiagnosesController {
  constructor(
    private readonly crashDiagnosesRepository: CrashDiagnosesRepository,
    private readonly appManagement: AppManagementService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'List crash diagnoses for an application' })
  @ApiQuery({
    name: 'status',
    enum: CrashDiagnosisStatusFilter,
    required: false,
  })
  async list(
    @Param('id') applicationId: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('offset', new ParseIntPipe({ optional: true })) offset?: number,
    @Query(
      'status',
      new ParseEnumPipe(CrashDiagnosisStatusFilter, { optional: true }),
    )
    status?: CrashDiagnosisStatusFilter,
  ): Promise<CrashDiagnosisDto[]> {
    const entries = await this.crashDiagnosesRepository.findByApplication(
      applicationId,
      {
        status: status ?? CrashDiagnosisStatusFilter.ALL,
        limit: limit ?? 50,
        offset: offset ?? 0,
      },
    );
    return entries.map((e) => this.toDto(e));
  }

  @Get(':diagnosisId')
  @ApiOperation({ summary: 'Get a single crash diagnosis' })
  async getOne(
    @Param('id') applicationId: string,
    @Param('diagnosisId') id: string,
  ): Promise<CrashDiagnosisDto> {
    const entry = await this.crashDiagnosesRepository.findById(id);
    if (entry?.applicationId !== applicationId) {
      throw new NotFoundException(`Crash diagnosis ${id} not found`);
    }
    return this.toDto(entry);
  }

  @Post(':diagnosisId/dismiss')
  @ApiOperation({ summary: 'Mark a crash diagnosis as resolved' })
  async dismiss(
    @Param('id') applicationId: string,
    @Param('diagnosisId') id: string,
  ): Promise<CrashDiagnosisDto> {
    const entry = await this.crashDiagnosesRepository.findById(id);
    if (entry?.applicationId !== applicationId) {
      throw new NotFoundException(`Crash diagnosis ${id} not found`);
    }
    await this.crashDiagnosesRepository.markResolved(id);
    const updated = await this.crashDiagnosesRepository.findById(id);
    return this.toDto(updated);
  }

  /**
   * Accept what a diagnosis proposes. Nothing proposed here is ever applied
   * without this call: the values are the ones the diagnosis already shows, and
   * they go through the same change as editing the resources by hand.
   */
  @Post(':diagnosisId/apply')
  @ApiOperation({
    summary: 'Apply the change a crash diagnosis proposes',
    description:
      'Applies the resource change a diagnosis proposes (today: a higher memory limit after an out-of-memory kill) and marks the diagnosis resolved. Refused when the diagnosis proposes nothing Flui can apply, or was already resolved.',
  })
  async apply(
    @Param('id') applicationId: string,
    @Param('diagnosisId') id: string,
  ): Promise<CrashDiagnosisDto> {
    const entry = await this.crashDiagnosesRepository.findById(id);
    if (entry?.applicationId !== applicationId) {
      throw new NotFoundException(`Crash diagnosis ${id} not found`);
    }
    if (entry.resolvedAt) {
      throw new ConflictException(
        'This diagnosis is already resolved; there is nothing left to apply.',
      );
    }
    const action = entry.suggestedAction;
    if (action?.type !== SuggestedActionType.RESOURCES || !action.payload) {
      throw new ConflictException(
        'This diagnosis proposes nothing Flui can apply. Its suggested action says what to do by hand.',
      );
    }
    await this.appManagement.updateResources(
      applicationId,
      action.payload as UpdateResourcesDto,
    );
    await this.crashDiagnosesRepository.markResolved(id);
    const updated = await this.crashDiagnosesRepository.findById(id);
    return this.toDto(updated);
  }

  private toDto(entity: CrashDiagnosisEntity): CrashDiagnosisDto {
    return {
      id: entity.id,
      applicationId: entity.applicationId,
      podName: entity.podName,
      containerName: entity.containerName,
      category: entity.category,
      severity: entity.severity,
      title: entity.title,
      explanation: entity.explanation,
      evidence: entity.evidence,
      patternMatchedKey: entity.patternMatchedKey,
      suggestedAction: entity.suggestedAction,
      resolvedAt: entity.resolvedAt,
      createdAt: entity.createdAt,
    };
  }
}
