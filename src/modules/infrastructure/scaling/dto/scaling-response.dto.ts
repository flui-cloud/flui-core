import { ApiProperty } from '@nestjs/swagger';
import { Sensitivity } from '../../../mask/decorators/sensitivity.decorator';
import { ScalingModeKind } from '../scaling-consequence';
import {
  CandidateOutcome,
  DecisionOutcome,
  PlacementStrategy,
  ProvisionMode,
  ScalingForce,
  StandingOrderKind,
} from '../scaling.core';

export class ProviderScalingCapabilityDto {
  @ApiProperty({ example: 'hetzner' })
  provider: string;

  @ApiProperty({
    description: 'Flui can create a server through the provider API',
  })
  canProvision: boolean;

  @ApiProperty({
    description: 'There is a list of shapes to read, with prices',
  })
  hasCatalogue: boolean;

  @ApiProperty({
    enum: ['hourly', 'monthly', 'none'],
    description: '`none` means Flui never sees a bill for these machines',
  })
  billing: 'hourly' | 'monthly' | 'none';
}

export class ScalingBoundsResponseDto {
  @ApiProperty({ description: 'The floor, held now and always' })
  min: number;

  @ApiProperty({
    description:
      'The target, approached opportunistically. Being below it buys nothing now.',
  })
  desired: number;

  @ApiProperty({ description: 'How far urgency may reach right now' })
  max: number;
}

export class ScalingLimitsResponseDto {
  @ApiProperty()
  hourlyBillingOnly: boolean;

  @ApiProperty({
    nullable: true,
    description:
      'In currency, not in node count. Null is no ceiling, not zero.',
  })
  maxMonthlyCost: number | null;
}

export class NodeRequirementResponseDto {
  @ApiProperty({ example: '2' })
  cpu: string;

  @ApiProperty({ example: '8Gi' })
  memory: string;
}

/** What the availability catalogue knows, and how old the knowing is. */
export class AvailabilityOutlookDto {
  @ApiProperty({ enum: ['available', 'limited', 'sold-out', 'recovered'] })
  state: 'available' | 'limited' | 'sold-out' | 'recovered';

  @ApiProperty({ type: [String] })
  upIn: string[];

  @ApiProperty({ type: [String] })
  downIn: string[];

  @ApiProperty({ nullable: true })
  sinceHours: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Age of the catalogue reading. Always carried: a cache passed off as a live reading is the one thing this must never do.',
  })
  ageSeconds: number | null;
}

export class DrainBlockerDto {
  @ApiProperty({
    enum: [
      'dedicated-app',
      'bound-volume',
      'no-controller',
      'disruption-budget',
      'not-evictable',
      'is-master',
    ],
  })
  kind: string;

  @ApiProperty()
  what: string;

  @ApiProperty()
  fix: string;
}

export class DrainCheckDto {
  @ApiProperty()
  ok: boolean;

  @ApiProperty({ type: [DrainBlockerDto] })
  blockers: DrainBlockerDto[];

  @ApiProperty({ type: [String] })
  cleared: string[];
}

export class StandingOrderResponseDto {
  @ApiProperty({ enum: ['expand', 'replace'] })
  kind: StandingOrderKind;

  @ApiProperty()
  shape: string;

  @ApiProperty()
  region: string;

  @ApiProperty()
  wanted: number;

  @ApiProperty({
    nullable: true,
    description: 'Always null when kind is expand',
  })
  replaces: string | null;

  /**
   * Null until a catalogue is read: what the market says about this shape is
   * not a property of the group, and storing a copy of it would age.
   */
  @ApiProperty({ type: AvailabilityOutlookDto, nullable: true })
  outlook: AvailabilityOutlookDto | null;

  /**
   * Null on an expansion — nothing is drained, so there is nothing to check —
   * and null on a replacement until the feasibility check exists to answer it.
   */
  @ApiProperty({ type: DrainCheckDto, nullable: true })
  drainable: DrainCheckDto | null;
}

/**
 * Whether anything this group decides would reach a provider, and why not.
 *
 * Separate from `capability.canProvision` on purpose: that says what the
 * *provider* permits, and a group set only to decide would otherwise read as
 * one that buys.
 */
export class ScalingModeDto {
  @ApiProperty({
    enum: ['automatic', 'manual', 'alarm-only'],
    description:
      '`alarm-only` where the provider has no create API, whatever the group says',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  mode: ScalingModeKind;

  @ApiProperty({
    example: 'Manual — Flui does not buy',
    description:
      'The mode in the same words on every surface: "Manual — Flui does not buy", "Automatic — buys up to €30/mo, 3 nodes", "Alarm only — Flui cannot buy on contabo"',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  label: string;

  @ApiProperty({
    description:
      'True where a person may expect scaling that will not happen: a group Flui could buy for, set to manual',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  attention: boolean;
}

export class ScalingActuationDto extends ScalingModeDto {
  @ApiProperty({
    description: 'Whether a decision by this group would reach a provider',
  })
  acts: boolean;

  @ApiProperty({
    description: 'What stands between this group and a purchase, in one line',
  })
  says: string;
}

export class PurchaseHoldDto {
  @ApiProperty({
    description: 'When the purchase that holds buying back failed',
  })
  failedAt: string;

  @ApiProperty({
    nullable: true,
    description: 'What the provider or Flui said',
  })
  error: string | null;

  @ApiProperty({
    nullable: true,
    description:
      'Set when the machine was sold out: nothing was created, and the hold ends by itself at this time, when availability decides again. Null means it holds until a person asks to try again.',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  until: string | null;
}

export class DecisionOperationDto {
  @ApiProperty({
    description:
      'GET /infrastructure/operations/:id for the whole record, /log for the node install log',
  })
  id: string;

  @ApiProperty({
    enum: ['pending', 'running', 'completed', 'failed', 'cancelled'],
  })
  state: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

  @ApiProperty({ description: '0–100' })
  progress: number;

  @ApiProperty({ nullable: true, description: 'What it is doing, or last did' })
  step: string | null;

  @ApiProperty({ nullable: true, description: 'Why it failed' })
  error: string | null;

  @ApiProperty({ nullable: true })
  finishedAt: string | null;
}

export class PurchaseInFlightDto {
  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ description: 'The decision that ordered it' })
  decisionId: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ example: '2026-09-25T13:35:00.000Z' })
  decidedAt: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  shape: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ nullable: true })
  region: string | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    enum: ['buying', 'joined', 'failed'],
    description:
      '`buying` while the operation runs; `joined` for a while after it completed; `failed` until the group is let buy again',
  })
  state: 'buying' | 'joined' | 'failed';

  @Sensitivity(Sensitivity.ARBITRARY_TEXT)
  @ApiProperty({
    description:
      'One line: "Buying cx23 in fsn1 — installing (60%)", "cx23 in fsn1 joined at 13:37, 2 min after it was ordered"',
  })
  says: string;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({ type: DecisionOperationDto })
  operation: DecisionOperationDto;
}

export class ScalingGroupResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty()
  clusterId: string;

  @ApiProperty()
  clusterName: string;

  @ApiProperty()
  provider: string;

  @ApiProperty({ type: ProviderScalingCapabilityDto })
  capability: ProviderScalingCapabilityDto;

  @ApiProperty({
    type: [String],
    nullable: true,
    description:
      'The regions a node bought for this cluster could actually join it ' +
      'from, or null where geography fences nothing — an unknown provider, a ' +
      'global network, or one Flui builds itself. A property of the network ' +
      'this cluster was given, not of what its provider sells: a machine can ' +
      'be on offer somewhere its private network cannot be reached from.',
  })
  buyableRegions: string[] | null;

  @ApiProperty({ type: ScalingBoundsResponseDto })
  bounds: ScalingBoundsResponseDto;

  @ApiProperty({ type: [String] })
  regions: string[];

  @ApiProperty({ type: [String], description: 'In order of preference' })
  shapes: string[];

  @ApiProperty({ enum: ['cheapest', 'closest', 'roomiest', 'uniform'] })
  strategy: PlacementStrategy;

  @ApiProperty({
    description:
      'How long an app must be stuck before this buys. Never a wait for a cheaper machine.',
  })
  settleSeconds: number;

  @ApiProperty({ type: ScalingLimitsResponseDto })
  limits: ScalingLimitsResponseDto;

  @ApiProperty({ enum: ['automatic', 'manual'] })
  provision: ProvisionMode;

  @ApiProperty({ type: [StandingOrderResponseDto] })
  standingOrders: StandingOrderResponseDto[];

  @ApiProperty({ type: ScalingActuationDto })
  acts: ScalingActuationDto;

  @ApiProperty({
    type: NodeRequirementResponseDto,
    nullable: true,
    description: 'What a machine must hold, where no catalogue names shapes',
  })
  requirement: NodeRequirementResponseDto | null;

  @ApiProperty({
    type: PurchaseHoldDto,
    nullable: true,
    description:
      'Set while a failed purchase holds this group back: nothing more is bought until someone asks it to try again (POST /infrastructure/scaling-groups/:id/retry-purchase) or a later purchase goes through.',
  })
  purchaseHeld: PurchaseHoldDto | null;

  @Sensitivity(Sensitivity.PUBLIC)
  @ApiProperty({
    type: PurchaseInFlightDto,
    nullable: true,
    description:
      'The last purchase this group ordered, while it is on its way and for 30 minutes after it joined or failed. Null when nothing was bought lately.',
  })
  purchase: PurchaseInFlightDto | null;
}

export class ConsideredCandidateDto {
  @ApiProperty({ nullable: true })
  shape: string | null;

  @ApiProperty({ nullable: true })
  region: string | null;

  @ApiProperty({ nullable: true })
  hourlyEur: number | null;

  @ApiProperty({
    enum: [
      'would-buy',
      'unavailable',
      'does-not-fit',
      'over-budget',
      'refused-by-limit',
      'alert',
    ],
  })
  outcome: CandidateOutcome;

  @ApiProperty({ required: false })
  note?: string;
}

export class ScalingDecisionResponseDto {
  @ApiProperty()
  id: string;

  @ApiProperty({ example: '2026-08-27T02:14:00.000Z' })
  at: string;

  @ApiProperty({ enum: ['urgency', 'opportunity'] })
  force: ScalingForce;

  @ApiProperty({
    enum: ['added', 'replaced', 'removed', 'declined', 'alerted', 'changed'],
  })
  outcome: DecisionOutcome;

  @ApiProperty({ description: 'What it saw' })
  saw: string;

  @ApiProperty({ description: 'What it did, or would have done' })
  did: string;

  @ApiProperty({
    description: 'Why — and on a decline this is the whole content',
  })
  why: string;

  @ApiProperty({
    nullable: true,
    description: 'The sentence addressed to a person, on an alarm',
  })
  asks: string | null;

  @ApiProperty({ nullable: true })
  shape: string | null;

  @ApiProperty({ nullable: true })
  region: string | null;

  @ApiProperty({ nullable: true })
  hourlyEur: number | null;

  @ApiProperty({
    type: [ConsideredCandidateDto],
    description: 'What it did not choose, and why each one lost',
  })
  considered: ConsideredCandidateDto[];

  @ApiProperty({
    type: DecisionOperationDto,
    nullable: true,
    description:
      'The purchase or removal this decision started, as it stands now. Null where the decision started nothing.',
  })
  operation: DecisionOperationDto | null;

  @ApiProperty({
    required: false,
    description:
      'With collapse=true: how many identical decisions in a row this one stands for (1 when it stands alone)',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  repeats?: number;

  @ApiProperty({
    required: false,
    description:
      'With collapse=true and repeats above 1: when the first of them was taken; `at` is the latest',
  })
  @Sensitivity(Sensitivity.PUBLIC)
  since?: string;
}

/**
 * A decision read from the cluster rather than from one of its groups, so it
 * has to say which group took it.
 */
export class ClusterScalingDecisionDto extends ScalingDecisionResponseDto {
  @ApiProperty()
  groupId: string;

  @ApiProperty({ description: 'The name the group carries on this cluster' })
  groupName: string;
}

/**
 * An alarm still standing, meaning the last thing the group decided was to ask
 * for a person.
 *
 * It is the group's current state and not an event waiting to be answered by
 * another one: the next decision replaces it, whether that is a machine arriving
 * or the decline written once somebody attached one by hand. An alarm that could
 * only be cleared by an outcome nothing produces would stand for good on exactly
 * the providers this surface exists for.
 */
export class OpenAlarmDto {
  @ApiProperty({ description: 'When the group last asked for a person' })
  since: string;

  @ApiProperty({
    description: 'What it asks for, in terms this cluster can be given',
  })
  asks: string;
}

/** A group named in the row of its cluster, so a second one is never invisible. */
export class ClusterScalingGroupRefDto {
  @ApiProperty()
  id: string;

  @ApiProperty()
  name: string;

  @ApiProperty({ enum: ['automatic', 'manual'] })
  provision: ProvisionMode;

  @ApiProperty({ type: ScalingBoundsResponseDto })
  bounds: ScalingBoundsResponseDto;
}

export class ClusterScalingRowDto {
  @ApiProperty()
  clusterId: string;

  @ApiProperty()
  clusterName: string;

  @ApiProperty({ type: ProviderScalingCapabilityDto })
  capability: ProviderScalingCapabilityDto;

  @ApiProperty({
    nullable: true,
    description: 'Null when no group is configured',
  })
  groupId: string | null;

  @ApiProperty({
    description:
      'How many groups this cluster holds. The row names the first; the count is what keeps a second one from being invisible.',
  })
  groupCount: number;

  @ApiProperty({
    type: [ClusterScalingGroupRefDto],
    description:
      'Every group on this cluster, in the order they were written. Carried in the row because a count alone leaves a second group unnamed until somebody fetches again — and one call has to answer what is on this cluster.',
  })
  groups: ClusterScalingGroupRefDto[];

  @ApiProperty({ type: ScalingBoundsResponseDto, nullable: true })
  bounds: ScalingBoundsResponseDto | null;

  @ApiProperty()
  nodes: number;

  @ApiProperty({
    nullable: true,
    description:
      'What the fleet commits to a month, over the nodes that carry a price. Null where Flui has no bill to show: the operator’s own machines, permanently, and any fleet where no node carries a price yet. Never 0 for either — a zero would read as free. Where `unpricedNodes` is not 0 this is a floor, not the bill.',
  })
  monthlyEur: number | null;

  @ApiProperty({
    description:
      'Nodes contributing nothing to `monthlyEur` because no price is known for them. A partially priced fleet must not read as cheap, so the count travels beside the figure rather than the rest being quietly summed.',
  })
  unpricedNodes: number;

  @ApiProperty({ nullable: true })
  monthlyCap: number | null;

  @ApiProperty({
    nullable: true,
    description:
      'Pods the scheduler could not place, as the last pass saw them. Null is "no group of this cluster could get an answer" — never 0, which would report calm during an outage.',
  })
  pendingPods: number | null;

  @ApiProperty({
    description:
      'Whether any group of this cluster is set to act, not merely to decide. False beside a provider Flui can buy from is the case worth naming: the provider allows a purchase that no group here will make.',
  })
  acts: boolean;

  @ApiProperty({
    type: ScalingModeDto,
    nullable: true,
    description:
      "The first group's mode, as its own page says it. Null with no group.",
  })
  @Sensitivity(Sensitivity.PUBLIC)
  mode: ScalingModeDto | null;

  @ApiProperty()
  openOrders: number;

  @ApiProperty({ description: 'Standing orders held back by a refused drain' })
  blockedOrders: number;

  @ApiProperty({ type: OpenAlarmDto, nullable: true })
  openAlarm: OpenAlarmDto | null;

  @ApiProperty({ nullable: true })
  lastDecisionAt: string | null;

  @ApiProperty({
    nullable: true,
    description: 'The one line that has to read from across the room',
  })
  needsPerson: string | null;
}
