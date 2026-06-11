import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { getProjectPath } from '../../../common/utils/project-root.util';
import { describeError } from '../../shared/utils/error.util';
import { AssistantRecommendationsDto } from '../dto/assistant-recommendations.dto';

const recommendedModelSchema = z.object({
  model: z.string().min(1),
  description: z.string().min(1),
  isDefault: z.boolean().optional(),
  note: z.string().optional(),
  requiresPaidPlan: z.boolean().optional(),
});

const recommendationGroupSchema = z.object({
  key: z.string().min(1),
  matchProvider: z.string().optional(),
  matchConnectionHost: z.string().optional(),
  models: z.array(recommendedModelSchema).min(1),
});

const recommendationsSchema = z.object({
  recommendedProvider: z.object({
    key: z.string().min(1),
    label: z.string().min(1),
    reason: z.string().min(1),
    defaultModel: z.string().min(1),
  }),
  groups: z.array(recommendationGroupSchema),
});

const ENV_OVERRIDE = 'ASSISTANT_RECOMMENDATIONS_PATH';

@Injectable()
export class AssistantRecommendationsService implements OnModuleInit {
  private readonly logger = new Logger(AssistantRecommendationsService.name);
  private recommendations!: AssistantRecommendationsDto;

  onModuleInit(): void {
    this.recommendations = this.loadAndValidate();
  }

  getRecommendations(): AssistantRecommendationsDto {
    return this.recommendations;
  }

  private loadAndValidate(): AssistantRecommendationsDto {
    const override = process.env[ENV_OVERRIDE]?.trim();
    const filePath =
      override ||
      getProjectPath(
        'src',
        'modules',
        'assistant',
        'config',
        'recommended-models.json',
      );

    let raw: string;
    try {
      // Path is server config (env override or a fixed bundled file), never user input.
      // eslint-disable-next-line security/detect-non-literal-fs-filename
      raw = readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(
        `Failed to read assistant recommendations from ${filePath}: ${describeError(error)}`,
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (error) {
      throw new Error(
        `Assistant recommendations at ${filePath} is not valid JSON: ${describeError(error)}`,
      );
    }

    const result = recommendationsSchema.safeParse(parsed);
    if (!result.success) {
      throw new Error(
        `Assistant recommendations at ${filePath} failed validation: ${z.prettifyError(result.error)}`,
      );
    }

    const source = override ? `override ${filePath}` : 'bundled default';
    this.logger.log(
      `Loaded assistant recommendations from ${source} ` +
        `(${result.data.groups.length} groups, recommended provider: ${result.data.recommendedProvider.key})`,
    );
    return result.data;
  }
}
