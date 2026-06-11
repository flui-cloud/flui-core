import {
  Controller,
  Delete,
  Get,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import { Request, Response } from 'express';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { AuthenticatedUser } from '../auth/interfaces/authenticated-user.interface';
import { McpServerFactory } from './services/mcp-server.factory';

/**
 * Streamable-HTTP MCP endpoint, in-process in flui-api. Stateless: each request
 * spins up a fresh server+transport bound to the authenticated principal, so
 * there is no session state to manage. The global JwtAuthGuard authenticates the
 * Bearer token; the MCP server itself gates each tool by scope.
 */
@ApiTags('mcp')
@ApiBearerAuth()
@Controller('mcp')
export class McpController {
  constructor(private readonly factory: McpServerFactory) {}

  @Post()
  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint (JSON-RPC over POST)',
  })
  async handlePost(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.dispatch(req, res, req.body);
  }

  @Get()
  @ApiOperation({
    summary: 'MCP Streamable HTTP endpoint (stream / 405 stateless)',
  })
  async handleGet(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.dispatch(req, res);
  }

  @Delete()
  @ApiOperation({ summary: 'MCP Streamable HTTP endpoint (session end)' })
  async handleDelete(@Req() req: Request, @Res() res: Response): Promise<void> {
    await this.dispatch(req, res);
  }

  private async dispatch(
    req: Request,
    res: Response,
    body?: unknown,
  ): Promise<void> {
    const user = req.user as AuthenticatedUser | undefined;
    if (!user) {
      throw new UnauthorizedException(
        'MCP requires an authenticated principal',
      );
    }

    const server = this.factory.build(user);
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });

    res.on('close', () => {
      void transport.close();
      void server.close();
    });

    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  }
}
