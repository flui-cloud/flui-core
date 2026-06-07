import { Injectable } from '@nestjs/common';
import { AuthenticatedUser } from '../../auth/interfaces/authenticated-user.interface';
import { DEFAULT_SCOPES } from '../constants/mcp-scopes';

/**
 * Resolves a principal's effective MCP scopes, issuer-agnostically. Scopes can
 * arrive from any credential the auth layer already populates:
 *   - an API key's `scopes` column or a token `scope` claim → `user.scopes`,
 *   - Zitadel project roles named `mcp:*`                   → `user.roles` keys.
 * With no explicit grant the principal gets the safe default (read + plan only);
 * write/destructive are never implied — they must be granted explicitly.
 */
@Injectable()
export class McpScopeResolver {
  resolve(user: AuthenticatedUser): Set<string> {
    const granted = new Set<string>();
    for (const scope of user.scopes ?? []) {
      if (scope.startsWith('mcp:')) granted.add(scope);
    }
    for (const roleKey of Object.keys(user.roles ?? {})) {
      if (roleKey.startsWith('mcp:')) granted.add(roleKey);
    }
    if (granted.size === 0) {
      DEFAULT_SCOPES.forEach((s) => granted.add(s));
    }
    return granted;
  }
}
