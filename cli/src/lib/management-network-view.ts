import chalk from 'chalk';
import {
  ManagementNetwork,
  ManagementNetworkHubNode,
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

function hubNodeLine(hub: ManagementNetworkHubNode): string {
  const tone = TONE[hub.status];
  const name = hub.nodeName ?? hub.nodeId ?? '—';
  const role = hub.primary ? chalk.dim(' (primary)') : '';
  const reached = hub.endpoint ? ` · reached at ${hub.endpoint}` : '';
  const up = hub.keyed ? '' : chalk.yellow(' · not up yet');
  const members = chalk.dim(
    `${hub.membersReached} member(s) reached, ${hub.membersNotReached} not`,
  );
  return `  ${tone('●')} ${name}${role}  ${hub.address}${reached}${up}  ${tone(hub.status)}  ${members}`;
}

function memberLine(m: ManagementNetworkMember): string {
  const handshake = m.lastHandshakeAt
    ? `last handshake ${m.lastHandshakeAt.replace('T', ' ').slice(0, 16)} UTC`
    : 'no handshake yet';
  const tone = TONE[m.status];
  const where = `${m.clusterName}/${m.nodeName ?? '—'}`;
  const unreached = m.unreachedFrom?.length
    ? chalk.yellow(`  not reached from ${m.unreachedFrom.join(', ')}`)
    : '';
  const held = m.heldOffOverlay
    ? chalk.yellow('  held on its public address')
    : '';
  return `  ${tone('●')} ${where}  ${m.address}  ${tone(m.status)}  ${chalk.dim(handshake)}${unreached}${held}`;
}

export function printManagementNetwork(network: ManagementNetwork): void {
  const state = network.enabled ? chalk.green('on') : chalk.yellow('off');
  const source = chalk.dim(`(${SOURCE[network.source]})`);
  console.log(`\n  Flui network: ${state} ${source}`);
  if (network.unavailable)
    console.log(chalk.yellow(`  ${network.unavailable}`));
  if (network.hubs?.length) {
    console.log('  Control ends:');
    for (const hub of network.hubs) console.log(hubNodeLine(hub));
  } else if (network.hub) console.log(hubLine(network.hub));
  if (network.hubProblem)
    console.log(
      chalk.red(
        `  The control's end is not set up, so members stay pending: ${network.hubProblem}`,
      ),
    );
  if (network.hubWarning) console.log(chalk.yellow(`  ${network.hubWarning}`));
  if (!network.members.length) {
    console.log(chalk.dim('  No member yet.\n'));
    return;
  }
  console.log('');
  for (const m of network.members) console.log(memberLine(m));
  console.log('');
}
