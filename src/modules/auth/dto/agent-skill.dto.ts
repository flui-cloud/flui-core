import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/** The instructions, plus the two facts that let a reader check they are current. */
export class AgentSkillDto {
  @ApiProperty({
    description:
      'The version of these instructions. It tracks the content, so a change ' +
      'to what the document says is a change to this string.',
    example: '1.0.0',
  })
  version: string;

  @ApiProperty({
    description:
      'Fingerprint of the document body before the installation’s own URLs are ' +
      'substituted in. Two instances on the same version agree on it.',
  })
  digest: string;

  @ApiProperty({ description: 'What to save it as.', example: 'SKILL.md' })
  filename: string;

  @ApiProperty({ example: 'text/markdown' })
  mediaType: string;

  @ApiProperty({ description: 'The MCP endpoint the document points at.' })
  mcpEndpoint: string;

  @ApiProperty({
    description: 'The document itself. Never contains a credential.',
  })
  content: string;
}

export class AgentCheckInDto {
  @ApiPropertyOptional({
    description:
      'The version of the skill this agent is working from. Omit it and the ' +
      'answer still describes the connection, but the person who issued the ' +
      'credential is left unable to tell what the agent is reading.',
    example: '1.0.0',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  skillVersion?: string;
}

/**
 * The connection, described to the agent making it.
 *
 * It answers "what am I attached to" without answering "what is this instance
 * hiding from me": every field is either a fact about the caller's own
 * credential or a fact about the endpoint it just used.
 */
export class AgentCheckInResultDto {
  @ApiProperty({ description: 'The MCP endpoint to call.' })
  mcpEndpoint: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'The name the credential was issued under, so the agent can say which ' +
      'one it holds. Null when the request did not arrive with an API key.',
  })
  credentialName: string | null;

  @ApiProperty({
    isArray: true,
    type: String,
    nullable: true,
    description:
      'The scopes the credential carries. Null means it declared none and ' +
      'therefore carries its issuer’s full weight.',
  })
  scopes: string[] | null;

  @ApiProperty({
    type: Date,
    nullable: true,
    description: 'When the credential stops working. Null means no expiry.',
  })
  expiresAt: Date | null;

  @ApiProperty({
    description: 'The skill version this instance publishes.',
    example: '1.0.0',
  })
  currentSkillVersion: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'The version the agent declared on this call, echoed back.',
  })
  declaredSkillVersion: string | null;

  @ApiProperty({
    enum: ['current', 'stale', 'ahead', 'unknown', 'undeclared'],
    description:
      '`stale` is the one that asks for action: re-fetch the skill. `ahead` ' +
      'means this instance is behind the agent, `unknown` that the declared ' +
      'string is not a version this instance can compare.',
  })
  skillFreshness: string;

  @ApiProperty({
    description:
      'Whether this check-in was written down against a credential the issuer ' +
      'can see. False when the request did not arrive with an API key — there ' +
      'is no row to record it on, and inventing one would show a connection ' +
      'nobody issued.',
  })
  recorded: boolean;
}
