import { InitialSchema1000000000000 } from './1000000000000-InitialSchema';
import { AlertEvents1784400000000 } from './1784400000000-AlertEvents';
import { AppDeployOnPush1784500000000 } from './1784500000000-AppDeployOnPush';
import { MailSuppressions1784600000000 } from './1784600000000-MailSuppressions';
import { MailEvents1784700000000 } from './1784700000000-MailEvents';
import { MailConnections1784800000000 } from './1784800000000-MailConnections';
import { SandboxTenants1784900000000 } from './1784900000000-SandboxTenants';
import { SandboxTenantReapAttempts1785000000000 } from './1785000000000-SandboxTenantReapAttempts';
import { OwnerRoleBackfill1785100000000 } from './1785100000000-OwnerRoleBackfill';
import { McpToolCallOutcome1785200000000 } from './1785200000000-McpToolCallOutcome';
import { ApiKeyHashAtRest1785300000000 } from './1785300000000-ApiKeyHashAtRest';
import { ApiKeyLastUsed1785400000000 } from './1785400000000-ApiKeyLastUsed';

// Explicit array, not a dist glob: nest build webpack-bundles to one file,
// so a `dist/migrations/*.js` glob resolves to nothing at runtime.
// Add new migrations below, in timestamp order.
export const migrations = [
  InitialSchema1000000000000,
  AlertEvents1784400000000,
  AppDeployOnPush1784500000000,
  MailSuppressions1784600000000,
  MailEvents1784700000000,
  MailConnections1784800000000,
  SandboxTenants1784900000000,
  SandboxTenantReapAttempts1785000000000,
  OwnerRoleBackfill1785100000000,
  McpToolCallOutcome1785200000000,
  ApiKeyHashAtRest1785300000000,
  ApiKeyLastUsed1785400000000,
];
