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
import { RenameEditorAndManagerRoles1785500000000 } from './1785500000000-RenameEditorAndManagerRoles';
import { ApplicationOwnerForeignKey1785600000000 } from './1785600000000-ApplicationOwnerForeignKey';
import { InferenceConnectionOwner1785700000000 } from './1785700000000-InferenceConnectionOwner';
import { AgentActorAudit1785800000000 } from './1785800000000-AgentActorAudit';
import { ActionCycle1785900000000 } from './1785900000000-ActionCycle';
import { OperatingContext1786000000000 } from './1786000000000-OperatingContext';
import { AgentSkillVersion1786100000000 } from './1786100000000-AgentSkillVersion';
import { McpToolCallRaisedProposal1786200000000 } from './1786200000000-McpToolCallRaisedProposal';
import { GitHubInstallationUnattributed1786300000000 } from './1786300000000-GitHubInstallationUnattributed';
import { OperatingContextArchivedBy1786400000000 } from './1786400000000-OperatingContextArchivedBy';
import { McpToolCallSurface1786500000000 } from './1786500000000-McpToolCallSurface';
import { ApplicationOwnerKind1786600000000 } from './1786600000000-ApplicationOwnerKind';
import { ClusterNodeShape1786700000000 } from './1786700000000-ClusterNodeShape';
import { ScalingGroup1786800000000 } from './1786800000000-ScalingGroup';
import { ApiKeyApplicationScope1786900000000 } from './1786900000000-ApiKeyApplicationScope';
import { ApiKeyProjectScope1787000000000 } from './1787000000000-ApiKeyProjectScope';
import { McpToolCallSemanticSurfaceRef1787100000000 } from './1787100000000-McpToolCallSemanticSurfaceRef';
import { VolumeCopyLedger1787200000000 } from './1787200000000-VolumeCopyLedger';
import { RestorePlacement1787300000000 } from './1787300000000-RestorePlacement';
import { ContinuousBackupEngine1787400000000 } from './1787400000000-ContinuousBackupEngine';
import { BackfillArtifactApplicationId1787500000000 } from './1787500000000-BackfillArtifactApplicationId';

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
  RenameEditorAndManagerRoles1785500000000,
  ApplicationOwnerForeignKey1785600000000,
  InferenceConnectionOwner1785700000000,
  AgentActorAudit1785800000000,
  ActionCycle1785900000000,
  OperatingContext1786000000000,
  AgentSkillVersion1786100000000,
  McpToolCallRaisedProposal1786200000000,
  GitHubInstallationUnattributed1786300000000,
  OperatingContextArchivedBy1786400000000,
  McpToolCallSurface1786500000000,
  ApplicationOwnerKind1786600000000,
  ClusterNodeShape1786700000000,
  ScalingGroup1786800000000,
  ApiKeyApplicationScope1786900000000,
  ApiKeyProjectScope1787000000000,
  McpToolCallSemanticSurfaceRef1787100000000,
  VolumeCopyLedger1787200000000,
  RestorePlacement1787300000000,
  ContinuousBackupEngine1787400000000,
  BackfillArtifactApplicationId1787500000000,
];
