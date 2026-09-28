import { Reflector } from '@nestjs/core';
import { CostsController } from './costs.controller';
import { REQUIRED_PERMISSION_KEY } from '../../iam/decorators/require-permission.decorator';
import { REQUIRED_SECTION_KEY } from '../../iam/decorators/require-section.decorator';
import { IAM_PERMISSION } from '../../iam/constants/iam-permissions';
import { ALL_TOOLS } from '../../mcp/tools/tool-registry';
import { MCP_SCOPE } from '../../mcp/constants/mcp-scopes';

describe('reading what the installation costs', () => {
  const reflector = new Reflector();

  it('answers for the whole instance, so it sits in the infrastructure section with the read permission', () => {
    const handler = CostsController.prototype.list;
    expect(reflector.get(REQUIRED_SECTION_KEY, handler)).toBe('infrastructure');
    expect(reflector.get(REQUIRED_PERMISSION_KEY, handler)).toBe(
      IAM_PERMISSION.CLUSTER_READ,
    );
  });

  it('is published to agents as a machine-room read', () => {
    const tool = ALL_TOOLS.find((t) => t.name === 'cost_overview');
    expect(tool?.scope).toBe(MCP_SCOPE.INFRA_READ);
    expect(tool?.routes).toEqual(['GET /infrastructure/costs']);
  });
});
