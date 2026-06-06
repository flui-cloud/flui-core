import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  ParseEnumPipe,
  Post,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';
import { ValidationResultDto } from '../../management/dto/validation-result.dto';
import { InferenceProviderService } from '../services/inference-provider.service';
import { InferenceConnectionService } from '../services/inference-connection.service';
import { CreateInferenceConnectionDto } from '../dto/create-inference-connection.dto';
import { InferenceProviderInfoDto } from '../dto/inference-provider-info.dto';
import { InferenceConnectionDto } from '../dto/inference-connection.dto';

@ApiTags('Inference')
@Controller('inference')
@ApiBearerAuth()
export class InferenceController {
  constructor(
    private readonly providers: InferenceProviderService,
    private readonly connections: InferenceConnectionService,
  ) {}

  @Get('providers')
  @ApiOperation({
    summary: 'List inference-capable providers and their models',
  })
  @ApiResponse({ status: 200, type: [InferenceProviderInfoDto] })
  async listProviders(): Promise<InferenceProviderInfoDto[]> {
    return this.providers.listProviders();
  }

  @Post('providers/:provider/validate')
  @ApiOperation({
    summary: 'Test the provider credential against its inference endpoint',
  })
  @ApiParam({ name: 'provider', enum: CloudProvider })
  @ApiResponse({ status: 200, type: ValidationResultDto })
  @HttpCode(HttpStatus.OK)
  async validateProvider(
    @Param('provider', new ParseEnumPipe(CloudProvider))
    provider: CloudProvider,
  ): Promise<ValidationResultDto> {
    return this.providers.validate(provider);
  }

  @Get('connections')
  @ApiOperation({ summary: 'List BYO inference connections' })
  @ApiResponse({ status: 200, type: [InferenceConnectionDto] })
  async listConnections(): Promise<InferenceConnectionDto[]> {
    return this.connections.list();
  }

  @Post('connections')
  @ApiOperation({ summary: 'Connect any OpenAI-compatible LLM (BYO-key)' })
  @ApiResponse({ status: 201, type: InferenceConnectionDto })
  async createConnection(
    @Body() dto: CreateInferenceConnectionDto,
  ): Promise<InferenceConnectionDto> {
    return this.connections.create(dto);
  }

  @Post('connections/:id/validate')
  @ApiOperation({ summary: 'Validate a BYO inference connection' })
  @ApiResponse({ status: 200, type: ValidationResultDto })
  @HttpCode(HttpStatus.OK)
  async validateConnection(
    @Param('id') id: string,
  ): Promise<ValidationResultDto> {
    return this.connections.validate(id);
  }

  @Delete('connections/:id')
  @ApiOperation({ summary: 'Delete a BYO inference connection' })
  @HttpCode(HttpStatus.NO_CONTENT)
  async deleteConnection(@Param('id') id: string): Promise<void> {
    await this.connections.remove(id);
  }
}
