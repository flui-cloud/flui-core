import {
  LadderInput,
  LadderResult,
  NODE_RESERVE,
  monthlyFrom,
} from './engine.core';
import { checkFit } from './fit.core';
import { FleetRoom } from './room.core';

export interface WhatIfAsk {
  cpuMillicores: number;
  memoryMi: number;
  replicas: number;
}

export const WHAT_IF_VERDICTS = [
  'fits',
  'buys',
  'proposes',
  'nothing-hosts',
  'unknown',
] as const;
export type WhatIfVerdict = (typeof WHAT_IF_VERDICTS)[number];

export interface MachineRoom {
  shape: string | null;
  cpuMillicores: number;
  memoryMi: number;
}

export interface WhatIfGroup {
  id: string;
  provision: 'automatic' | 'manual';
  input: LadderInput;
  ladder: LadderResult;
}

export interface WhatIfAnswer {
  verdict: WhatIfVerdict;
  sentence: string;
  node: string | null;
  groupId: string | null;
  provision: 'automatic' | 'manual' | null;
  shape: string | null;
  region: string | null;
  monthlyEur: number | null;
  why: string | null;
  largest: MachineRoom | null;
}

export function placeOnFleet(ask: WhatIfAsk, room: FleetRoom): string | null {
  const open = room.nodes
    .filter((node) => node.takesWork)
    .map((node) => ({ name: node.name, ...node.free }));
  const replicas = Math.max(1, ask.replicas);
  const fit = checkFit(
    Array.from({ length: replicas }, (_, index) => ({
      name: `replica-${index + 1}`,
      cpuMillicores: ask.cpuMillicores,
      memoryMi: ask.memoryMi,
    })),
    open,
  );
  if (!fit.fits) return null;
  const home = [...open]
    .sort((a, b) => b.memoryMi - a.memoryMi)
    .find(
      (node) =>
        node.cpuMillicores >= ask.cpuMillicores &&
        node.memoryMi >= ask.memoryMi,
    );
  return home?.name ?? null;
}

/**
 * The biggest single replica a machine this group may buy could hold, the
 * system reserve set aside. Availability is not weighed: a machine sold out
 * today is still one the group can buy tomorrow, and the money ceiling is.
 */
export function largestBuyable(input: LadderInput): MachineRoom | null {
  const cap = input.group.maxMonthlyCost;
  const committed = input.fleet.committedMonthlyEur;
  let best: MachineRoom | null = null;
  for (const name of input.group.shapes) {
    const fact = input.shapes.shapes.find((entry) => entry.shape === name);
    if (!fact || fact.deprecated) continue;
    const affordable =
      cap === null ||
      fact.prices.some((price) => {
        const monthly = price.monthlyEur ?? monthlyFrom(price.hourlyEur);
        return monthly === null || committed + monthly <= cap;
      });
    if (!affordable) continue;
    const room: MachineRoom = {
      shape: name,
      cpuMillicores: Math.max(
        0,
        fact.cores * 1000 - NODE_RESERVE.cpuMillicores,
      ),
      memoryMi: Math.max(0, fact.memoryMi - NODE_RESERVE.memoryMi),
    };
    if (!best || room.memoryMi > best.memoryMi) best = room;
  }
  return best;
}

export function largestNode(room: FleetRoom): MachineRoom | null {
  return room.nodes.reduce<MachineRoom | null>((best, node) => {
    const candidate: MachineRoom = {
      shape: null,
      cpuMillicores: Math.max(
        0,
        node.allocatable.cpuMillicores - NODE_RESERVE.cpuMillicores,
      ),
      memoryMi: Math.max(0, node.allocatable.memoryMi - NODE_RESERVE.memoryMi),
    };
    return !best || candidate.memoryMi > best.memoryMi ? candidate : best;
  }, null);
}

function biggest(
  a: MachineRoom | null,
  b: MachineRoom | null,
): MachineRoom | null {
  if (!a) return b;
  if (!b) return a;
  return b.memoryMi > a.memoryMi ? b : a;
}

function holds(machine: MachineRoom | null, ask: WhatIfAsk): boolean {
  return (
    !!machine &&
    machine.cpuMillicores >= ask.cpuMillicores &&
    machine.memoryMi >= ask.memoryMi
  );
}

function monthlyOfRung(group: WhatIfGroup): number | null {
  const chosen = group.ladder.chosen;
  if (!chosen?.shape) return null;
  const fact = group.input.shapes.shapes.find(
    (entry) => entry.shape === chosen.shape,
  );
  const price = fact?.prices.find((entry) => entry.region === chosen.region);
  return price?.monthlyEur ?? monthlyFrom(chosen.hourlyEur);
}

function priced(monthly: number | null): string {
  return monthly === null ? '' : ` (€${monthly} a month)`;
}

export function answerWhatIf(
  ask: WhatIfAsk,
  room: FleetRoom | null,
  groups: WhatIfGroup[],
): WhatIfAnswer {
  const base: WhatIfAnswer = {
    verdict: 'unknown',
    sentence: 'The cluster could not be asked how much room it has.',
    node: null,
    groupId: null,
    provision: null,
    shape: null,
    region: null,
    monthlyEur: null,
    why: null,
    largest: null,
  };
  if (!room) return base;

  const largest = groups.reduce<MachineRoom | null>(
    (best, group) => biggest(best, largestBuyable(group.input)),
    largestNode(room),
  );
  const many = ask.replicas > 1;

  const node = placeOnFleet(ask, room);
  if (node) {
    return {
      ...base,
      verdict: 'fits',
      node,
      largest,
      sentence: many
        ? `All ${ask.replicas} replicas fit on the nodes already there: nothing is bought.`
        : `Fits on ${node}: nothing is bought.`,
    };
  }

  const miss = many
    ? `The ${ask.replicas} replicas do not all fit on the nodes already there`
    : 'It does not fit on the nodes already there';

  const winner = groups.find((group) => group.ladder.chosen);
  if (winner?.ladder.chosen) {
    const { shape, region } = winner.ladder.chosen;
    const monthly = monthlyOfRung(winner);
    const automatic = winner.provision === 'automatic';
    return {
      ...base,
      verdict: automatic ? 'buys' : 'proposes',
      groupId: winner.id,
      provision: winner.provision,
      shape,
      region,
      monthlyEur: monthly,
      largest,
      sentence: automatic
        ? `${miss}: Flui would buy a ${shape} in ${region}${priced(monthly)}.`
        : `${miss}. The group is manual: it would propose a ${shape} in ${region}${priced(monthly)} and buy nothing until a person does.`,
    };
  }

  const first = groups[0];
  if (!first) {
    return {
      ...base,
      verdict: 'nothing-hosts',
      largest,
      sentence: `${miss}, and this cluster has no scaling group to buy one: it would wait for room.`,
    };
  }

  return {
    ...base,
    verdict: 'nothing-hosts',
    groupId: first.id,
    provision: first.provision,
    largest,
    why: first.ladder.asks,
    sentence: holds(largestBuyable(first.input), ask)
      ? `${miss}, and no machine the group may buy that could take it can be had right now: it would wait for room.`
      : `${miss}, and it is bigger than any machine the group may buy: it would wait for room.`,
  };
}
