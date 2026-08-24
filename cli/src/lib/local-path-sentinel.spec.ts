import * as ts from 'typescript';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join } from 'path';

/**
 * The fence around the local path (decision 125).
 *
 * `getNestApp` starts `CliModule` **inside the operator's own process**, and
 * `CliInfrastructureModule` mounts repositories backed by files in
 * `~/.flui/*.json` under the TypeORM tokens, so the shared services cannot tell
 * they have no database. Everything that runs down there therefore holds the
 * process, the code, and the rows any policy would be evaluated against. That is
 * why the boundary here is not a runtime chokepoint — a guard evaluated on data
 * its subject can edit with a text editor is a ceremony, not a gate. The gate is
 * possession of the profile, its store and the workstation vault; what this file
 * adds is the other half: the list of who is allowed down there is **written
 * down, with a reason each**, and cannot grow in silence.
 *
 * Three counting claims, in the shape `wire-catalog.spec.ts` and
 * `route-permission-sentinel.spec.ts` already use in the API:
 *
 *  1. **who can start the module at all** — two files, no more;
 *  2. **who takes the local path** — the 36 commands, each with the reason it is
 *     not reachable over HTTP;
 *  3. **what the local path still resolves out of its own container** — the
 *     shared domain services a user-owned process constructs for itself. This is
 *     the number step 3 moves: a command whose deciding call went to a guarded
 *     route disappears from it.
 *
 * A command that wants any of the three declares itself here, with the reason
 * beside it, or the suite goes red. That is the rule of the "heap to leave where
 * it is" from step 2, applied to code.
 */
const CLI_SRC = join(__dirname, '..');

/** Reads the source rather than booting anything — the whole point is to see
 * what is written, without starting the module the file is about. */
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith('.ts') && !entry.endsWith('.spec.ts'))
      out.push(full);
  }
  return out;
}

const relative = (file: string): string =>
  file.slice(CLI_SRC.length + 1).replace(/\\/g, '/');

interface FileFacts {
  /** Imports `getNestApp` or `getService`, the two doors that start the module. */
  takesLocalPath: boolean;
  /** Names `NestFactory`, i.e. can start a module without going through them. */
  bootsDirectly: boolean;
  /** `app.get(X)` where `X` was imported from the API tree. */
  containerReaches: string[];
  /** Imports `CliSshService`, i.e. can run a command on the master itself. */
  opensSsh: boolean;
}

/** An import specifier that resolves into the API's own source tree. */
const isSharedDomain = (specifier: string): boolean =>
  /(^|\/)src\/modules\//.test(specifier);

function read(file: string): FileFacts {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const importedFrom = new Map<string, string>();
  const facts: FileFacts = {
    takesLocalPath: false,
    bootsDirectly: false,
    containerReaches: [],
    opensSsh: false,
  };

  const walkImports = (node: ts.Node): void => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      const specifier = node.moduleSpecifier.text;
      const bindings = node.importClause?.namedBindings;
      if (bindings && ts.isNamedImports(bindings)) {
        for (const element of bindings.elements) {
          const original = (element.propertyName ?? element.name).text;
          importedFrom.set(element.name.text, specifier);
          if (
            /nest-app$/.test(specifier) &&
            (original === 'getNestApp' || original === 'getService')
          ) {
            facts.takesLocalPath = true;
          }
          if (original === 'NestFactory') facts.bootsDirectly = true;
          if (original === 'CliSshService') facts.opensSsh = true;
        }
      }
    }
    ts.forEachChild(node, walkImports);
  };

  const walkCalls = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === 'get' &&
      node.arguments.length > 0 &&
      ts.isIdentifier(node.arguments[0])
    ) {
      const symbol = node.arguments[0].text;
      const from = importedFrom.get(symbol);
      if (from && isSharedDomain(from)) facts.containerReaches.push(symbol);
    }
    ts.forEachChild(node, walkCalls);
  };

  walkImports(source);
  walkCalls(source);
  facts.containerReaches = [...new Set(facts.containerReaches)].sort();
  return facts;
}

const FACTS = new Map<string, FileFacts>(
  sourceFiles(CLI_SRC).map((file) => [relative(file), read(file)]),
);

/**
 * `viaApi` marks a command whose *deciding* call — the mutation, or the
 * resolution of the resource it acts on — travels over HTTP and meets the guard
 * chain, even though the file still starts the module for identity and
 * transport. It is the honest unit of progress for step 3: converting a command
 * does not remove it from the list below, it changes this flag.
 */
interface LocalPathEntry {
  viaApi?: true;
  why: string;
}

const LOCAL_PATH: Record<string, LocalPathEntry> = {
  // ── the deciding call already travels over HTTP ────────────────────────────
  'commands/db/credentials.ts': {
    viaApi: true,
    why: 'Resolves the database through the API; the local path is only the SSH read of the in-cluster Secret.',
  },
  'commands/db/tunnel.ts': {
    viaApi: true,
    why: 'Resolves the database through the API; the local path is the SSH tunnel and the socket on this machine.',
  },
  'commands/env/firewall/apply.ts': {
    viaApi: true,
    why: 'POST /firewalls/cluster/:id/enable. The local path supplies identity and the cluster’s own key when nobody is logged in.',
  },
  'commands/env/firewall/status.ts': {
    viaApi: true,
    why: 'GET /firewalls/cluster/:id, same identity-and-transport-only use of the local path as its sibling.',
  },
  'commands/env/capacity.ts': {
    viaApi: true,
    why: 'GET :id/capacity-plan. Converted in step 3: reads a live cluster, so the API is up by precondition.',
  },
  'commands/env/storage.ts': {
    viaApi: true,
    why: 'GET :id/storage. Converted in step 3: a read of a live cluster.',
  },
  'commands/env/storage-expand.ts': {
    viaApi: true,
    why: 'POST :id/storage/expand. Converted in step 3: grows a volume on a live cluster and costs money, so it belongs behind the section gate.',
  },
  'commands/env/scale-node.ts': {
    viaApi: true,
    why: 'POST :id/nodes/:nodeId/scale. Converted in step 3: resizes a worker on a live cluster — never the master, so it never takes the API down under itself.',
  },
  'commands/env/uncordon.ts': {
    viaApi: true,
    why: 'POST :id/nodes/:nodeId/uncordon. Converted in step 3: it used to open an SSH session to the master to run kubectl, which is a far larger power than the route it needed.',
  },

  // ── the API does not exist yet at the moment of the call ───────────────────
  'commands/env/create.ts': {
    why: 'Builds the cluster the API will run on. Its own HTTP calls go to the instance it has just created, never to a pre-existing one.',
  },
  'commands/server-types/list.ts': {
    why: 'Chooses a server type before there is a cluster to ask.',
  },

  // ── the operation kills, or presumes dead, the API it would have called ────
  'commands/env/destroy.ts': {
    why: 'Deletes the servers the API runs on.',
  },
  'commands/env/stop.ts': {
    why: 'Shuts the servers down; the API stops with them.',
  },
  'commands/env/restart.ts': {
    why: 'Powers stopped servers back on through the provider. There is no HTTP that can serve this: the endpoint is off.',
  },
  'commands/env/reinstall.ts': {
    why: 'Wipes k3s and Flui state on the existing server and re-runs the bootstrap over SSH.',
  },
  'commands/env/scale-master.ts': {
    why: 'Resizes the very host that carries the API and its database, powering it off in the middle.',
  },

  // ── recovery: the premise is that something is already broken ──────────────
  'commands/env/status.ts': {
    why: 'Must answer when the API does not. It is the fallback the converted commands point at.',
  },
  'commands/env/force-ready.ts': {
    why: 'Unsticks a cluster row the API’s own view of the world got wrong.',
  },
  'commands/env/refresh-kubeconfig.ts': {
    why: 'Fetches the real kubeconfig off the master over SSH; there is deliberately no route that serves one.',
  },
  'commands/env/repair-ssh-ca.ts': {
    why: 'Backfills the SSH CA into the in-cluster Secret from the local profile — the repair for an instance whose terminal is broken.',
  },
  'commands/env/repair-storage.ts': {
    why: 'Patches flui-secrets over SSH and restarts flui-api, i.e. it repairs the process that would have served the route.',
  },
  'commands/env/diag-ca.ts': {
    why: 'Diagnoses the certificate chain, which is what a caller would need working to reach any route.',
  },
  'commands/env/inspect.ts': {
    why: 'Reads remote logs over SSH when the instance is not answering.',
  },
  'commands/env/sync.ts': {
    why: 'Re-derives endpoint URLs from the cluster over SSH+kubectl, including the API URL itself.',
  },
  'commands/dns/cleanup.ts': {
    why: 'Clears records left behind by a cluster that no longer exists.',
  },
  'commands/env/orphan-volumes.ts': {
    why: 'Recovers volumes left by past destroys, and computes "orphan" against this machine’s store. Deliberately not converted: it is the tool for after a cluster died, and it must not need that cluster’s API to run.',
  },
  'commands/env/update-firewall.ts': {
    why: 'Drives the cloud firewall directly so it works when the current IP is locked out. Deliberately not converted: converting the lockout remedy to the door that is locked is a net loss.',
  },

  // ── no route exists, and step 7 says new infrastructure writes come after
  //    step 6 ─────────────────────────────────────────────────────────────────
  'commands/env/cordon.ts': {
    why: 'The inverse of uncordon has no route. Not created here: a new write on infrastructure is step 7, which is barred before step 6.',
  },
  'commands/env/set-master-protection.ts': {
    why: 'Taints the master over SSH and has no route. Same reason as cordon, plus it writes a flag into this machine’s cluster row.',
  },

  // ── the effect is on the machine of whoever runs it ────────────────────────
  'commands/env/logs.ts': {
    why: 'Reads the operations this machine’s store recorded.',
  },
  'commands/env/export-config.ts': {
    why: 'Writes a .env in the working directory.',
  },
  'commands/env/credentials.ts': {
    why: 'Decrypts the cluster secrets held on this machine to print sign-in instructions.',
  },
  'commands/dev/creds.ts': {
    why: 'Writes cluster secrets into a local .env.local for development.',
  },
  'commands/dev/tunnel.ts': {
    why: 'Opens SSH tunnels and binds ports on localhost.',
  },
  'commands/node/connect.ts': {
    viaApi: true,
    why: 'Registers the worker through POST :id/byos-nodes (best-effort, in the creator service); the k3s join itself runs over SSH with the operator’s own key.',
  },
  'commands/ssh.ts': {
    why: 'Opens a shell on a node. Already settled: an agent with a shell has no fence left, so this one is perimeter by definition.',
  },
};

const MODULE_BOOTERS: Record<string, string> = {
  'lib/nest-app.ts':
    'The one door. Everything above goes through it, which is what makes the list above countable.',
  'background/cluster-worker.ts':
    'A detached process for create/delete/reinstall — the three lifecycle operations that outlive the command that started them. It calls NestFactory itself, so a sentinel that only watched getNestApp would not have seen it.',
};

describe('only the named files can start CliModule on the operator’s machine', () => {
  /**
   * The first claim, and the one that makes the second worth anything: a second
   * bootstrap function would let a command take the local path without ever
   * naming `getNestApp`, and the list below would go on looking complete.
   */
  it('names every file that reaches for NestFactory', () => {
    const booters = [...FACTS.entries()]
      .filter(([, facts]) => facts.bootsDirectly)
      .map(([file]) => file)
      .sort();
    expect(booters).toEqual(Object.keys(MODULE_BOOTERS).sort());
  });

  it('gives each of them a reason', () => {
    const unexplained = Object.entries(MODULE_BOOTERS)
      .filter(([, why]) => why.trim().length === 0)
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });
});

describe('the local path is a list somebody wrote down', () => {
  const measured = [...FACTS.entries()]
    .filter(([, facts]) => facts.takesLocalPath)
    .map(([file]) => file)
    .sort();

  /**
   * Thirty-six, counted rather than remembered. A new command that wants the
   * local path fails here first, and the way to make it pass is to say why —
   * which is the whole mechanism. Removing one is equally loud, so the list
   * cannot rot in the other direction either.
   */
  it('is exactly the files declared here', () => {
    expect(measured).toEqual(Object.keys(LOCAL_PATH).sort());
  });

  it('leaves no entry without a reason', () => {
    const unexplained = Object.entries(LOCAL_PATH)
      .filter(([, entry]) => entry.why.trim().length === 0)
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });

  /**
   * How many of the thirty-six decide behind the guard chain rather than in
   * process. The number moves only when a command changes side, which is the
   * point: it cannot drift quietly.
   *
   * Two commands measured as convertible keep the local path on purpose, and
   * both are named above with the reason: `orphan-volumes` and `update-firewall`
   * are the tools for after the cluster, or the way in, is already gone —
   * asking the closed door for that service is the net loss. Two more have no
   * route at all.
   */
  it('has ten of the thirty-six deciding over HTTP', () => {
    const viaApi = Object.entries(LOCAL_PATH)
      .filter(([, entry]) => entry.viaApi)
      .map(([file]) => file);
    expect({ total: measured.length, viaApi: viaApi.length }).toEqual({
      total: 36,
      viaApi: 10,
    });
  });
});

/**
 * The sharper question, and the one a count of importers cannot ask.
 *
 * Starting the module for identity and transport is cheap and honest — the
 * firewall pair has done it since it was written. Pulling a *shared domain
 * service* out of a container the caller owns is the thing that has no guard in
 * front of it at all: `ClusterNodeScalingService.scaleNode` spends the operator's
 * money whether or not anybody may call the route that wraps it.
 *
 * Twelve pairs across eleven files, down from nineteen across fifteen: the four
 * commands converted in step 3 stopped constructing cluster services for
 * themselves. Every survivor is a lifecycle, recovery or workstation command
 * from the list above — which is the shape the decision predicted, now checkable.
 */
describe('what the local path still resolves out of its own container', () => {
  const IN_PROCESS: Record<string, string> = {
    'commands/env/create.ts  ::  FirewallProviderFactory':
      'Creates the cluster’s first firewall before the cluster exists.',
    'commands/env/restart.ts  ::  HetznerProviderService':
      'Powers servers on. The provider is the only party that can, and the API is off.',
    'commands/env/stop.ts  ::  HetznerProviderService':
      'Powers them off, taking the API with them.',
    'commands/env/scale-master.ts  ::  ClusterCapacityService':
      'Plans the resize of the host the API runs on.',
    'commands/env/scale-master.ts  ::  ClusterNodeScalingService':
      'Performs it, powering that host off mid-operation.',
    'commands/env/orphan-volumes.ts  ::  ProviderFactory':
      'Scans providers for volumes after the cluster that owned them is gone.',
    'commands/env/update-firewall.ts  ::  FirewallProviderFactory':
      'Rewrites the SSH allowlist from outside, which is the point when the allowlist is what locked you out.',
    'commands/server-types/list.ts  ::  ProviderFactory':
      'Lists server types before any cluster exists to ask.',
    'commands/env/credentials.ts  ::  EncryptionService':
      'Decrypts secrets held in this machine’s store; nothing leaves it.',
    'commands/dev/creds.ts  ::  EncryptionService':
      'Same, for a developer’s .env.local.',
    'commands/env/refresh-kubeconfig.ts  ::  EncryptionService':
      'Same, to reach the master over SSH and fetch the real kubeconfig.',
    'commands/dns/cleanup.ts  ::  HetznerDnsService':
      'Deletes records belonging to a cluster that no longer answers.',
  };

  it('is exactly the reaches declared here', () => {
    const measured = [...FACTS.entries()]
      .flatMap(([file, facts]) =>
        facts.containerReaches.map((symbol) => `${file}  ::  ${symbol}`),
      )
      .sort();
    expect(measured).toEqual(Object.keys(IN_PROCESS).sort());
  });

  it('leaves no reach without a reason', () => {
    const unexplained = Object.entries(IN_PROCESS)
      .filter(([, why]) => why.trim().length === 0)
      .map(([reach]) => reach);
    expect(unexplained).toEqual([]);
  });

  /**
   * Nothing that reaches in process may be a command whose deciding call is
   * declared to travel over HTTP: the two states are exclusive, and a command
   * that claimed both would be the exact shape of the second, ungoverned door
   * this fence exists to keep shut.
   */
  it('never lets a converted command keep a shared service', () => {
    const converted = new Set(
      Object.entries(LOCAL_PATH)
        .filter(([, entry]) => entry.viaApi)
        .map(([file]) => file),
    );
    const both = Object.keys(IN_PROCESS)
      .map((reach) => reach.split('  ::  ')[0])
      .filter((file) => converted.has(file));
    expect([...new Set(both)]).toEqual([]);
  });
});

/**
 * The other way a command declared "behind the guards" could still be deciding
 * for itself: a shell on the master runs anything, so an SSH session is a wider
 * power than any route it could have called instead. `uncordon` is exactly that
 * story — it used to reach `kubectl uncordon` over SSH, and the route it now
 * calls is the narrow version of the same act.
 *
 * Three converted commands keep a session, and none of them keeps it to decide:
 * each has already asked the API which resource it may touch, and uses the
 * session as a pipe.
 */
describe('a converted command does not keep a shell to decide with', () => {
  const SSH_AFTER_THE_DECISION: Record<string, string> = {
    'commands/db/credentials.ts':
      'Reads the in-cluster Secret of a database the API already resolved and authorised.',
    'commands/db/tunnel.ts':
      'Forwards a port to that same database; the tunnel is transport, not a decision.',
    'commands/node/connect.ts':
      'Joins the host to k3s with the operator’s own key, after the API has registered the node.',
  };

  it('names the converted commands that still open one', () => {
    const withShell = Object.entries(LOCAL_PATH)
      .filter(([file, entry]) => entry.viaApi && FACTS.get(file)?.opensSsh)
      .map(([file]) => file)
      .sort();
    expect(withShell).toEqual(Object.keys(SSH_AFTER_THE_DECISION).sort());
  });

  it('leaves none of them without a reason', () => {
    const unexplained = Object.entries(SSH_AFTER_THE_DECISION)
      .filter(([, why]) => why.trim().length === 0)
      .map(([file]) => file);
    expect(unexplained).toEqual([]);
  });
});
