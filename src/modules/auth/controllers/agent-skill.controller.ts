import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Request,
  UseGuards,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
} from '@nestjs/swagger';
import { JwtAuthGuard } from '../guards/jwt-auth.guard';
import { AuthenticatedUser } from '../interfaces/authenticated-user.interface';
import { ApiKeyService } from '../services/api-key.service';
import {
  CURRENT_API_KEY_ID,
  RequestWithApiKey,
} from '../strategies/api-key.strategy';
import {
  AGENT_SKILL_FILENAME,
  AGENT_SKILL_MEDIA_TYPE,
  AGENT_SKILL_VERSION,
  agentSkillDigest,
  renderAgentSkill,
  skillFreshness,
} from '../constants/agent-skill';
import {
  AgentCheckInDto,
  AgentCheckInResultDto,
  AgentSkillDto,
} from '../dto/agent-skill.dto';

/**
 * The two halves of a connection, one route each.
 *
 * `GET agent-skill` hands over the instructions that teach an agent how work is
 * done here, carrying a version so that "these are the current ones" is a
 * question with an answer. `POST agent-skill/check-in` is the agent saying
 * which version it holds — and it is the only reason the person who issued the
 * credential can ever see anything but silence.
 *
 * Neither route asks for a permission, and that is the same rule three other
 * routes on this instance already follow: **what you may do with a credential
 * you are already holding is not a further decision**. The skill describes the
 * product, not this installation's contents — no name, no application, no
 * cluster appears in it — and the check-in reaches exactly one row, the one
 * that authenticated the request. There is nothing here a permission could
 * narrow, and gating it would only strand an agent that cannot find out whether
 * its own instructions are stale.
 *
 * The credential never enters the document. `renderAgentSkill` takes two URLs
 * and nothing else, so there is no argument through which one could — which is
 * the "no secret inside a skill" rule made structural instead of remembered.
 */
@ApiTags('auth')
@ApiBearerAuth()
@Controller('auth/agent-skill')
@UseGuards(JwtAuthGuard)
export class AgentSkillController {
  constructor(
    private readonly apiKeys: ApiKeyService,
    private readonly config: ConfigService,
  ) {}

  @Get()
  @ApiOperation({
    summary: 'The skill that teaches an agent how to work on this instance',
    description:
      'Markdown, versioned by its content. Hand it to the agent alongside the ' +
      'credential — it never contains one itself, and asking for it again is ' +
      'how an agent that has gone stale catches up.',
  })
  @ApiOkResponse({ type: AgentSkillDto })
  skill(): AgentSkillDto {
    const { mcpEndpoint, apiBaseUrl } = this.endpoints();
    return {
      version: AGENT_SKILL_VERSION,
      digest: agentSkillDigest(),
      filename: AGENT_SKILL_FILENAME,
      mediaType: AGENT_SKILL_MEDIA_TYPE,
      mcpEndpoint,
      content: renderAgentSkill({ mcpEndpoint, apiBaseUrl }),
    };
  }

  /**
   * What the agent is attached to, and what the issuer can see of it.
   *
   * One row, overwritten. There is no history here on purpose: the useful fact
   * is what the thing on the other end is reading *now*, and a series of
   * check-ins would be a movement log of somebody's agent kept where nobody
   * audits it. What an agent actually did is recorded elsewhere, deliberately.
   */
  @Post('check-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Announce which skill version this agent is working from',
    description:
      'Answers with the connection as the agent needs to understand it — the ' +
      'endpoint, the credential’s name, its scopes and expiry — and with ' +
      'whether the declared version is still the current one. Recorded against ' +
      'the API key that made the call, so the person who issued it can see the ' +
      'connection is alive and what it is reading.',
  })
  @ApiOkResponse({ type: AgentCheckInResultDto })
  async checkIn(
    @Request() req: { user: AuthenticatedUser } & RequestWithApiKey,
    @Body() dto: AgentCheckInDto,
  ): Promise<AgentCheckInResultDto> {
    const { mcpEndpoint } = this.endpoints();
    const declared = dto.skillVersion?.trim() || null;
    const keyId = req[CURRENT_API_KEY_ID];
    const key = keyId ? await this.apiKeys.findById(keyId) : null;

    // Nothing is written for a session that did not arrive with an API key —
    // an interactive bearer token has no row to be the connection. Saying so is
    // the honest answer; creating a row would show a connection nobody issued.
    const recorded =
      !!key && !!declared
        ? await this.apiKeys.recordSkillVersion(key.id, declared)
        : false;

    return {
      mcpEndpoint,
      credentialName: key?.name ?? null,
      scopes: key?.scopes ?? null,
      expiresAt: key?.expiresAt ?? null,
      currentSkillVersion: AGENT_SKILL_VERSION,
      declaredSkillVersion: declared,
      skillFreshness: skillFreshness(declared),
      recorded,
    };
  }

  /**
   * Where this instance answers, as an agent outside it must address it.
   *
   * The public address is the one fact the process cannot derive: it knows the
   * port it listens on and nothing about the name it is reached by. The same
   * three variables the mail webhook registrar reads, in the same order, so an
   * install that configured its address once does not have to do it again;
   * localhost last, which keeps a development instance's document usable
   * instead of emitting a URL that is confidently wrong.
   */
  private endpoints(): { mcpEndpoint: string; apiBaseUrl: string } {
    const configured = ['PUBLIC_API_URL', 'FLUI_API_ENDPOINT', 'API_BASE_URL']
      .map((key) => this.config.get<string>(key)?.trim())
      .find((value) => !!value);
    let base =
      configured ||
      `http://localhost:${this.config.get<string>('PORT') ?? '3000'}`;
    while (base.endsWith('/')) base = base.slice(0, -1);
    const apiBaseUrl = `${base}/api/v1`;
    return { apiBaseUrl, mcpEndpoint: `${apiBaseUrl}/mcp` };
  }
}
