import { Command, Flags } from '@oclif/core';
import chalk from 'chalk';
import { ApiClient } from '../lib/api-client';
import { ConfigStorage } from '../lib/config-storage';

interface TrafficWatch {
  measuredAt: string;
  nodes: Array<{
    clusterId: string;
    node: string;
    mbpsOut: number;
    mbpsIn: number;
    monthPaceBytes: number;
    includedTb: number | null;
  }>;
  edges: Array<{
    clusterId: string;
    rpsNow: number;
    rpsBefore: number;
    rateLimited10m: number;
    requests10m: number;
    serverErrors10m: number;
  }>;
  thresholds: {
    nodeMbps: number;
    monthlyTrafficPercent: number;
    spikeFactor: number;
    spikeMinRps: number;
    rateLimitedPer10m: number;
    edgeErrorPercent: number;
  };
}

interface ClusterRow {
  id: string;
  name: string;
}

export default class Traffic extends Command {
  static readonly description =
    "Show the installation's traffic against the alert thresholds: each node's bandwidth and where this month is heading against what its provider includes, and for each cluster the requests arriving, those turned away by a rate limit and those that got a server error.";

  static readonly examples = [
    '<%= config.bin %> <%= command.id %>',
    '<%= config.bin %> <%= command.id %> --json',
  ];

  static readonly flags = {
    json: Flags.boolean({ description: 'Print the raw figures as JSON' }),
  };

  async run(): Promise<void> {
    const { flags } = await this.parse(Traffic);
    const config = new ConfigStorage();
    const api = new ApiClient({
      baseUrl: config.getApiUrlOrThrow(),
      apiKey: config.getApiKeyOrThrow(),
    });
    const t = await api.get<TrafficWatch>('/observability/traffic');
    if (flags.json) {
      console.log(JSON.stringify(t, null, 2));
      return;
    }
    const clusters = await api
      .get<ClusterRow[] | { data?: ClusterRow[] }>('/infrastructure/clusters')
      .then((r) => (Array.isArray(r) ? r : (r.data ?? [])))
      .catch(() => [] as ClusterRow[]);
    const nameOf = (id: string) =>
      clusters.find((c) => c.id === id)?.name ?? id.slice(0, 8);
    const th = t.thresholds;
    const flag = (over: boolean, text: string) =>
      over ? chalk.yellow(text) : text;

    console.log('');
    console.log(
      chalk.bold('  Nodes') +
        chalk.dim(`  (alert at ${th.nodeMbps} Mbit/s for ten minutes)`),
    );
    for (const n of t.nodes) {
      const busiest = Math.max(n.mbpsOut, n.mbpsIn);
      const month =
        n.includedTb === null
          ? 'not metered'
          : `${(n.monthPaceBytes / 1e12).toFixed(2)} of ${n.includedTb} TB this month at this week's pace`;
      const share =
        n.includedTb === null
          ? 0
          : (n.monthPaceBytes / (n.includedTb * 1e12)) * 100;
      const bandwidth = `${n.mbpsOut.toFixed(1)} out / ${n.mbpsIn.toFixed(1)} in Mbit/s`;
      console.log(
        `    ${n.node.padEnd(42)} ${flag(th.nodeMbps > 0 && busiest >= th.nodeMbps, bandwidth)}  ${flag(share >= th.monthlyTrafficPercent, month)}`,
      );
    }
    console.log('');
    console.log(
      chalk.bold('  Requests arriving') +
        chalk.dim('  (last 5 minutes; refusals and errors over 10 minutes)'),
    );
    for (const e of t.edges) {
      const surge =
        e.rpsNow >= th.spikeMinRps &&
        e.rpsNow >= th.spikeFactor * Math.max(e.rpsBefore, 0.01);
      const errors =
        e.requests10m > 0 ? (e.serverErrors10m / e.requests10m) * 100 : 0;
      const rate = `${e.rpsNow.toFixed(1)}/s (before ${e.rpsBefore.toFixed(1)}/s)`;
      const limited = `${Math.round(e.rateLimited10m)} rate-limited`;
      const failed = `${errors.toFixed(1)}% server errors`;
      console.log(
        `    ${nameOf(e.clusterId).padEnd(42)} ${flag(surge, rate)}  ${flag(e.rateLimited10m >= th.rateLimitedPer10m, limited)}  ${flag(errors >= th.edgeErrorPercent && e.requests10m > 0, failed)}`,
      );
    }
    console.log(
      chalk.dim(
        `\n  Measured ${new Date(t.measuredAt).toLocaleString()}. Figures in yellow are past an alert threshold.\n`,
      ),
    );
  }
}
