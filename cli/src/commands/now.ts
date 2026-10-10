import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client';
import { ConfigStorage } from '../lib/config-storage';

interface InstallationNow {
  measuredAt: string;
  nodes: Array<{
    clusterName: string;
    node: string;
    cpuPercent: number | null;
    memoryPercent: number | null;
    mbpsOut: number;
    mbpsIn: number;
    monthPaceBytes: number;
    includedTb: number | null;
  }>;
  edges: Array<{
    clusterName: string;
    rpsNow: number;
    rpsBefore: number;
    rateLimited10m: number;
    requests10m: number;
    serverErrors10m: number;
  }>;
  platform: Array<{
    name: string;
    cpuPercent: number | null;
    memoryPercent: number | null;
    restartsLastHour: number;
  }>;
  registry: {
    requests: { pulls: number; pushes: number };
    outcomes: { refused: number; failed: number };
    bytesOut: number;
    peakBytesPerSecondOut: number;
  } | null;
  sandbox: {
    live: number;
    warm: number;
    ceiling: number;
    waiting: number;
    fullRefusals: number;
  } | null;
  alerts: { firing: number; critical: number; names: string[] };
  thresholds: {
    nodeMbps: number;
    spikeFactor: number;
    spikeMinRps: number;
    rateLimitedPer10m: number;
    edgeErrorPercent: number;
  };
}

const pct = (v: number | null, warnAt: number): string => {
  if (v === null) return chalk.dim('  –');
  const text = `${Math.round(v)}%`.padStart(4);
  if (v >= 90) return chalk.red(text);
  return v >= warnAt ? chalk.yellow(text) : text;
};

const mib = (bytes: number): string => `${(bytes / 2 ** 20).toFixed(1)} MiB`;

type Thresholds = InstallationNow['thresholds'];

function alertSummary(alerts: InstallationNow['alerts']): string {
  if (alerts.firing === 0) return chalk.green('no alert firing');
  const criticalText = `${alerts.critical} critical`;
  const critical = alerts.critical > 0 ? chalk.red(criticalText) + ', ' : '';
  const firingText = `${alerts.firing} firing`;
  return `${critical}${chalk.yellow(firingText)}: ${alerts.names.join(', ')}`;
}

function nodeLine(
  node: InstallationNow['nodes'][number],
  th: Thresholds,
): string {
  const busy = Math.max(node.mbpsOut, node.mbpsIn) >= th.nodeMbps;
  const link = `${node.mbpsOut.toFixed(1)}/${node.mbpsIn.toFixed(1)}`;
  return `    ${node.node.padEnd(38)} ${pct(node.cpuPercent, 75)} ${pct(node.memoryPercent, 80)}  ${busy ? chalk.yellow(link) : link}`;
}

function edgeLine(e: InstallationNow['edges'][number], th: Thresholds): string {
  const surge =
    e.rpsNow >= th.spikeMinRps &&
    e.rpsNow >= th.spikeFactor * Math.max(e.rpsBefore, 0.01);
  const errPct =
    e.requests10m > 0 ? (e.serverErrors10m / e.requests10m) * 100 : 0;
  const surgeTone = surge ? chalk.yellow : String;
  const limitedTone =
    e.rateLimited10m >= th.rateLimitedPer10m ? chalk.yellow : String;
  const errorTone =
    errPct >= th.edgeErrorPercent && e.requests10m > 0 ? chalk.red : String;
  const errText = `${errPct.toFixed(1)}%`.padStart(5);
  return `    ${e.clusterName.padEnd(38)} ${surgeTone(e.rpsNow.toFixed(1).padStart(5))}  ${e.rpsBefore.toFixed(1).padStart(8)}  ${limitedTone(String(Math.round(e.rateLimited10m)).padStart(3))}  ${errorTone(errText)}`;
}

function platformLine(p: InstallationNow['platform'][number]): string {
  const restarts =
    p.restartsLastHour > 0 ? chalk.yellow(String(p.restartsLastHour)) : '0';
  return `    ${p.name.padEnd(38)} ${pct(p.cpuPercent, 75)} ${pct(p.memoryPercent, 80)}  ${restarts}`;
}

function registryLine(r: NonNullable<InstallationNow['registry']>): string {
  const refusedText = `, ${r.outcomes.refused} refused`;
  const failedText = `, ${r.outcomes.failed} failed`;
  return (
    `    ${r.requests.pulls} pulls, ${r.requests.pushes} pushes, ${mib(r.bytesOut)} out, peak ${((r.peakBytesPerSecondOut * 8) / 1e6).toFixed(1)} Mbit/s` +
    (r.outcomes.refused > 0 ? chalk.yellow(refusedText) : '') +
    (r.outcomes.failed > 0 ? chalk.red(failedText) : '')
  );
}

function sandboxLine(s: NonNullable<InstallationNow['sandbox']>): string {
  const waitingText = `, ${s.waiting} waiting`;
  const refusalsText = `, ${s.fullRefusals} turned away`;
  return (
    `    ${s.live} of ${s.ceiling} spaces in use, ${s.warm} ready` +
    (s.waiting > 0 ? chalk.yellow(waitingText) : ', nobody waiting') +
    (s.fullRefusals > 0 ? chalk.yellow(refusalsText) : '')
  );
}

function render(n: InstallationNow): string {
  const th = n.thresholds;
  const out: string[] = [];
  const head = (title: string) => out.push('', chalk.bold(`  ${title}`));
  out.push(
    chalk.dim(`  ${new Date(n.measuredAt).toLocaleTimeString()}`) +
      `  ${alertSummary(n.alerts)}`,
  );

  head('Nodes                                      CPU  Mem  Mbit/s out/in');
  for (const node of n.nodes) out.push(nodeLine(node, th));
  head('Requests at the door                       now/s  before/s  429  5xx');
  for (const e of n.edges) out.push(edgeLine(e, th));
  head('Platform                                   CPU  Mem  restarts/h');
  for (const p of n.platform) out.push(platformLine(p));
  if (n.registry) {
    head('Image registry, last hour');
    out.push(registryLine(n.registry));
  }
  if (n.sandbox) {
    head('Demo');
    out.push(sandboxLine(n.sandbox));
  }
  out.push('');
  return out.join('\n');
}

export default class Now extends Command {
  static readonly description =
    'Everything that runs out first under a crowd, in one screen: nodes (CPU, memory, bandwidth), requests at each cluster (surges, rate-limited, server errors), the platform components against their limits, the image registry and the demo spaces, with the alerts firing. Yellow is past an alert threshold.';

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --watch',
  ];

  static readonly flags = {
    watch: Flags.boolean({
      description: 'Refresh until interrupted',
    }),
    interval: Flags.integer({
      description: 'Seconds between refreshes with --watch',
      default: 30,
      min: 10,
    }),
    json: Flags.boolean({ description: 'Print the raw reading as JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Now);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const read = () => api.get<InstallationNow>('/observability/now');
    if (flags.json) {
      console.log(JSON.stringify(await read(), null, 2));
      return;
    }
    if (!flags.watch) {
      console.log(render(await read()));
      return;
    }
    for (;;) {
      const text = await read().then(render, (error: Error) =>
        chalk.red(`  Could not read the installation: ${error.message}`),
      );
      process.stdout.write('\u001B[2J\u001B[H' + text);
      await new Promise((r) => setTimeout(r, flags.interval * 1000));
    }
  }
}
