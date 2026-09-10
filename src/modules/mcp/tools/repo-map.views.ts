/**
 * The engine's map, cut to what a coding agent can actually hold — without
 * taking away the two things that make a fact checkable.
 *
 * Measured, on this repository's own tree: the full map of a 4000-file
 * repository is ~177 KB of JSON, of which ~53 KB is duplication rather than
 * information. Two duplications, specifically:
 *
 *  - every fact carries `source` — the rendered citation, `main.go:14` — AND
 *    `evidence[]`, which is the same citation in the machine-foldable form the
 *    survey layer merges on. The package says so itself (`survey-types.d.ts`,
 *    on `Evidence`). The compact view drops `evidence[]` and keeps `source` and
 *    `confidence`, so every fact still says where it came from and how firm it
 *    is.
 *  - `render.units[]` carries `manifest` AND `yaml`, the same manifest twice.
 *    `yaml` is the encoding the rest of the product takes as input —
 *    `app_manifest_validate`, `app_deploy_from_yaml`, and the commit an apply
 *    lands — so it is the one that stays.
 *
 * Everything a decision turns on is kept whole: the read boundary, the verdict
 * and its taxonomy, capacity, blockers, caveats and open questions with their
 * evidence, every required input by name. What is compacted is prose and
 * repetition, and `detail: 'full'` hands back the untouched DTO for anyone who
 * wants it — a compact default with a stated way out is not a summary.
 */

export type MapDetail = 'decision' | 'evidence' | 'full';

interface Scoped {
  unit?: string | null;
}

interface EnvVarish {
  name?: string;
  role?: string;
}

interface Unitish {
  id?: string;
  env?: EnvVarish[];
}

interface Renderedish {
  unitId?: string;
}

interface Verdictish {
  units?: Array<{ id?: string }>;
  [key: string]: unknown;
}

interface Readish {
  commitSha?: string;
  truncated?: boolean;
  contentComplete?: boolean;
  highDensityUnread?: string[];
}

interface MapResponseish {
  repositoryId?: string;
  repoFullName?: string;
  branch?: string;
  read?: Readish;
  map?: Record<string, unknown> | null;
  verdict?: Verdictish;
  render?: Record<string, unknown> | null;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

const list = (value: unknown): Record<string, unknown>[] =>
  Array.isArray(value) ? value.filter(isRecord) : [];

/** The named keys that are actually present. An absent key stays absent. */
function pick(
  source: Record<string, unknown>,
  keys: string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) {
    if (source[key] !== undefined) out[key] = source[key];
  }
  return out;
}

/**
 * A unit's 142 environment variables are 25 KB of the map and the single
 * largest block in it. What a decision needs from them is how many there are
 * and what they are called, per role — the citation for each one is in
 * `inputs[]`, where the ones that block a start already live.
 */
function envSummary(env: EnvVarish[]): Record<string, unknown> {
  const names: Record<string, string[]> = {};
  for (const variable of env) {
    const role = typeof variable.role === 'string' ? variable.role : 'unknown';
    const name = typeof variable.name === 'string' ? variable.name : '?';
    names[role] ??= [];
    names[role].push(name);
  }
  const counts: Record<string, number> = {};
  for (const [role, roleNames] of Object.entries(names)) {
    counts[role] = roleNames.length;
  }
  return { total: env.length, counts, names };
}

/** An entry scoped to this unit, or to the repository as a whole. */
const inUnit = (entry: Scoped, unitId?: string): boolean =>
  !unitId || entry.unit === unitId || entry.unit === null;

function compactMap(
  map: Record<string, unknown>,
  detail: MapDetail,
  unitId?: string,
): Record<string, unknown> {
  const deep = detail === 'evidence';
  const units = list(map.units)
    .filter((unit) => !unitId || (unit as Unitish).id === unitId)
    .map((unit) => {
      const base = pick(unit, [
        'id',
        'name',
        'root',
        'reason',
        'build',
        'port',
        'healthPath',
        'manifest',
        'manifests',
        'confidence',
        ...(deep ? ['evidence'] : []),
      ]);
      return { ...base, env: envSummary((unit as Unitish).env ?? []) };
    });

  const services = list(map.services)
    .filter((service) => inUnit(service as Scoped, unitId))
    .map((service) =>
      pick(service, [
        'name',
        'block',
        'engine',
        'family',
        'unit',
        'confidence',
        'injectionKeys',
        'alternativesGroup',
        'preferred',
        'alternativeRefs',
        'variantWarning',
        'source',
        ...(deep ? ['signals', 'evidence'] : []),
      ]),
    );

  // Every input, always — a required input dropped from the list is a deploy
  // that starts and then fails on a variable nobody was told about. What is
  // dropped is the rendered sentence in `reason` (43 KB of the 53 KB these
  // cost), never a name.
  const inputs = list(map.inputs)
    .filter((input) => inUnit(input as Scoped, unitId))
    .map((input) =>
      pick(input, [
        'name',
        'secret',
        'blocksStart',
        'forService',
        'unit',
        'source',
        ...(deep ? ['reason', 'evidence'] : []),
      ]),
    );

  const externals = list(map.externals)
    .filter((external) => inUnit(external as Scoped, unitId))
    .map((external) =>
      pick(external, [
        'name',
        'requires',
        'unit',
        'confidence',
        'source',
        ...(deep ? ['evidence'] : []),
      ]),
    );

  const scopedWhole = (value: unknown) =>
    list(value).filter((entry) => inUnit(entry as Scoped, unitId));

  return {
    units,
    services,
    inputs,
    externals,
    // Whole, with their evidence, at every detail level: these are the only
    // part of the map that says "nobody decided this".
    blockers: scopedWhole(map.blockers),
    caveats: scopedWhole(map.caveats),
    questions: list(map.questions),
    coverage: map.coverage,
    ...(deep ? { decisions: list(map.decisions), boundary: map.boundary } : {}),
  };
}

function compactRender(
  render: Record<string, unknown>,
  unitId?: string,
): Record<string, unknown> {
  const units = list(render.units)
    .filter((unit) => !unitId || (unit as Renderedish).unitId === unitId)
    // `manifest` is dropped: it is `yaml` in another encoding, and `yaml` is
    // the encoding every other tool here takes as input.
    .map((unit) => pick(unit, ['unitId', 'name', 'yaml']));
  return { units, skipped: list(render.skipped), notes: list(render.notes) };
}

function compactVerdict(
  verdict: Verdictish,
  detail: MapDetail,
  unitId?: string,
): Record<string, unknown> {
  const deep = detail === 'evidence';
  const units = (verdict.units ?? [])
    .filter(isRecord)
    .filter((unit) => !unitId || unit.id === unitId)
    .map((unit) =>
      pick(unit, [
        'id',
        'readiness',
        'reason',
        'remedy',
        ...(deep ? ['evidence'] : []),
      ]),
    );
  return {
    ...pick(verdict as Record<string, unknown>, [
      'outcome',
      'reason',
      'remedy',
      'capacity',
      ...(deep ? ['evidence'] : []),
    ]),
    units,
  };
}

/** What the caller has to know about this answer before acting on it. */
function noteFor(
  read: Readish | undefined,
  detail: MapDetail,
  unitId?: string,
): string {
  const parts: string[] = [];
  if (read?.commitSha) {
    parts.push(
      `This map is of commit ${read.commitSha}. Nothing is cached — a second call re-reads the branch and may answer about a different commit, so compare read.commitSha before treating two answers as one.`,
    );
  }
  if (read?.truncated || read?.contentComplete === false) {
    parts.push(
      'The repository was NOT read to the end (read.truncated / read.contentComplete). Facts absent from this map may simply not have been looked at; read.highDensityUnread names what was left.',
    );
  }
  if (unitId) {
    parts.push(
      `Narrowed to unit "${unitId}": units, services, inputs, verdict.units and render.units carry only this unit, plus the entries scoped to the whole repository (unit: null).`,
    );
  }
  if (detail !== 'full') {
    parts.push(
      "Compact view: every fact keeps its `source` citation (file:line) and its `confidence`, and every required input is listed by name. Left out are the second machine-readable copy of each citation (`evidence[]`), the prose in `inputs[].reason`, per-unit `env[]` (summarised by role) and `render.units[].manifest` (the same manifest as `yaml`). Ask for detail:'evidence' to get the citations and reasons back, or detail:'full' for the untouched response.",
    );
  }
  return parts.join(' ');
}

/**
 * The map, at the asked-for depth. `full` is the DTO exactly as the API served
 * it — the escape hatch that keeps the default compaction honest.
 */
export function projectRepositoryMap(
  data: unknown,
  detail: MapDetail,
  unitId?: string,
): unknown {
  if (detail === 'full' || !isRecord(data)) return data;
  const response = data as MapResponseish;
  const map = isRecord(response.map)
    ? compactMap(response.map, detail, unitId)
    : null;
  const render = isRecord(response.render)
    ? compactRender(response.render, unitId)
    : null;
  return {
    ...pick(data, ['repositoryId', 'repoFullName', 'branch']),
    detail,
    // Whole, always. It is the half of the answer that says where the engine
    // stopped looking, and it is small.
    read: response.read,
    verdict: isRecord(response.verdict)
      ? compactVerdict(response.verdict as Verdictish, detail, unitId)
      : response.verdict,
    map,
    render,
    note: noteFor(response.read, detail, unitId),
  };
}

/** Every unit id this map knows, so a bad `unitId` can name the real ones. */
export function unitIdsOf(data: unknown): string[] {
  if (!isRecord(data)) return [];
  const response = data as MapResponseish;
  const ids = new Set<string>();
  if (isRecord(response.map)) {
    for (const unit of list(response.map.units)) {
      if (typeof unit.id === 'string') ids.add(unit.id);
    }
  }
  if (isRecord(response.render)) {
    for (const unit of list(response.render.units)) {
      if (typeof unit.unitId === 'string') ids.add(unit.unitId);
    }
  }
  return [...ids];
}

interface Appliedish {
  armed?: boolean;
  slug?: string;
  applicationId?: string;
  pendingInputs?: string[];
}

/**
 * What an apply answered, said to the agent that asked for it.
 *
 * Almost nothing is dropped — the response is already the right size — and the
 * one thing added is the sentence that keeps a half-finished apply from being
 * retried blindly. A commit that landed is real: repeating the call cuts
 * nothing new (the branch name is the base commit) and builds nothing twice,
 * it just fails on a branch that already exists.
 */
export function projectRepositoryApply(data: unknown): unknown {
  if (!isRecord(data)) return data;
  const units = list(data.units);
  const files = Array.isArray(data.files) ? (data.files as string[]) : [];
  const unarmed = units.filter((unit) => (unit as Appliedish).armed === false);
  const owed = units.filter(
    (unit) => ((unit as Appliedish).pendingInputs ?? []).length > 0,
  );

  const parts: string[] = [];
  if (units.length > 0) {
    parts.push(
      `The commit has landed and one GitHub Actions build per unit is running. Follow each with app_status on its applicationId; nothing polls them for you.`,
    );
  }
  if (data.partial === true) {
    parts.push(
      `PARTIAL: ${unarmed.length} unit(s) were committed but not armed — their builds run and their webhooks answer 401, so they will not deploy on their own. Do NOT repeat this call: the commit is real and a second apply from the same commit is refused. Read units[].reason and act on that.`,
    );
  }
  if (owed.length > 0) {
    const names = owed
      .map(
        (unit) =>
          `${(unit as Appliedish).slug ?? '?'}: ${((unit as Appliedish).pendingInputs ?? []).join(', ')}`,
      )
      .join('; ')
      .slice(0, 400);
    parts.push(
      `Variables still owed (${names}). They are secret: ask a person for each with app_variable_request — you must not carry the value yourself, and app_variable_set refuses a key the product knows to be sensitive. app_variables lists the state per application.`,
    );
  }
  if (list(data.skipped).length > 0) {
    parts.push(
      'Some units were not rendered and nothing was committed or created for them — see skipped[].',
    );
  }

  return {
    ...pick(data, [
      'repositoryId',
      'repoFullName',
      'baseBranch',
      'baseCommitSha',
      'branch',
      'branchUrl',
      'commitSha',
      'commitUrl',
      'partial',
      'skipped',
      'verdict',
      'verdictReason',
    ]),
    files: { count: files.length, paths: files },
    units,
    note: parts.join(' '),
  };
}
