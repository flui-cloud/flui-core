/**
 * Would the work on a node still have somewhere to run without it?
 *
 * Asked before a node is given back. A node above the fleet's target is not
 * spare because it is above the target: it is spare only if what runs on it can
 * be placed on the machines that stay. Without this question a fleet under
 * steady load buys a node, sees nothing waiting, hands the node back, finds the
 * same work waiting again, and buys it again — a loop that is billed on every
 * turn.
 *
 * Placement is simulated the way a scheduler would attempt it, largest first,
 * each pod into the first machine with room on both counts. It is deliberately
 * the cautious reading: anything this cannot place counts as having nowhere to
 * go, and the node stays.
 */

export interface MovingPod {
  name: string;
  cpuMillicores: number;
  memoryMi: number;
}

/** What a machine that stays can still take, reserve already set aside. */
export interface NodeRoom {
  name: string;
  cpuMillicores: number;
  memoryMi: number;
}

export interface FitCheck {
  fits: boolean;
  /** What has to move, in total. */
  needs: { cpuMillicores: number; memoryMi: number };
  /** What the machines that stay can take, in total. */
  room: { cpuMillicores: number; memoryMi: number };
  /** What found no machine. Empty exactly when `fits`. */
  stranded: string[];
}

export function checkFit(moving: MovingPod[], rooms: NodeRoom[]): FitCheck {
  const left = rooms.map((room) => ({ ...room }));
  const stranded: string[] = [];

  // Memory first, as the pending side ranks it: it is the dimension a node most
  // often cannot hold, and placing the hardest first is what keeps a greedy
  // fill from wasting the one machine that could have taken it.
  const order = [...moving].sort(
    (a, b) => b.memoryMi - a.memoryMi || b.cpuMillicores - a.cpuMillicores,
  );

  for (const pod of order) {
    const home = left.find(
      (room) =>
        room.cpuMillicores >= pod.cpuMillicores &&
        room.memoryMi >= pod.memoryMi,
    );
    if (!home) {
      stranded.push(pod.name);
      continue;
    }
    home.cpuMillicores -= pod.cpuMillicores;
    home.memoryMi -= pod.memoryMi;
  }

  return {
    fits: stranded.length === 0,
    needs: total(moving),
    room: total(rooms),
    stranded,
  };
}

/** Said the way a person would check it: what has to move against where it could go. */
export function fitSummary(fit: FitCheck): string {
  const needs = `${fit.needs.cpuMillicores}m of CPU and ${fit.needs.memoryMi}Mi of memory`;
  if (fit.fits) {
    return `What runs on it — ${needs} — fits on the machines that stay.`;
  }
  const room = `${Math.max(0, fit.room.cpuMillicores)}m and ${Math.max(0, fit.room.memoryMi)}Mi`;
  const who =
    fit.stranded.length === 1
      ? fit.stranded[0]
      : `${fit.stranded.length} apps, ${fit.stranded[0]} among them`;
  return `What runs on it needs ${needs}; the machines that stay have room for ${room}, and ${who} would have nowhere to run.`;
}

function total(items: Array<{ cpuMillicores: number; memoryMi: number }>) {
  return items.reduce(
    (sum, item) => ({
      cpuMillicores: sum.cpuMillicores + item.cpuMillicores,
      memoryMi: sum.memoryMi + item.memoryMi,
    }),
    { cpuMillicores: 0, memoryMi: 0 },
  );
}
