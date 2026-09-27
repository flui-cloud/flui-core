import chalk from 'chalk';
import {
  ManagementNetwork,
  ManagementNetworkMember,
} from './management-network-client';

const SOURCE: Record<ManagementNetwork['source'], string> = {
  setting: 'switched by a person',
  install: 'chosen at install',
  default: 'on by default',
};

const TONE: Record<
  ManagementNetworkMember['status'],
  (text: string) => string
> = {
  active: chalk.green,
  stale: chalk.red,
  pending: chalk.yellow,
};

function hubLine(hub: NonNullable<ManagementNetwork['hub']>): string {
  const reached = hub.endpoint ? ` · reached at ${hub.endpoint}` : '';
  const up = hub.keyed ? '' : chalk.yellow(' · not up yet');
  return `  Control end: ${hub.address}${reached}${up}`;
}

function memberLine(m: ManagementNetworkMember): string {
  const handshake = m.lastHandshakeAt
    ? `last handshake ${m.lastHandshakeAt.replace('T', ' ').slice(0, 16)} UTC`
    : 'no handshake yet';
  const tone = TONE[m.status];
  const where = `${m.clusterName}/${m.nodeName ?? '—'}`;
  return `  ${tone('●')} ${where}  ${m.address}  ${tone(m.status)}  ${chalk.dim(handshake)}`;
}

export function printManagementNetwork(network: ManagementNetwork): void {
  const state = network.enabled ? chalk.green('on') : chalk.yellow('off');
  const source = chalk.dim(`(${SOURCE[network.source]})`);
  console.log(`\n  Flui network: ${state} ${source}`);
  if (network.unavailable)
    console.log(chalk.yellow(`  ${network.unavailable}`));
  if (network.hub) console.log(hubLine(network.hub));
  if (!network.members.length) {
    console.log(chalk.dim('  No member yet.\n'));
    return;
  }
  console.log('');
  for (const m of network.members) console.log(memberLine(m));
  console.log('');
}
