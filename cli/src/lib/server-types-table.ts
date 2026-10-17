import chalk from 'chalk';
import {
  archCell,
  archLabel,
  armWarningLine,
} from './server-architecture-view';

export interface ServerTypeRow {
  id: string;
  name: string;
  cores: string;
  memory: string;
  disk: string;
  architecture: string | null | undefined;
  availability: { label: string; color: (s: string) => string };
  price: string;
  regions: string;
}

const widthOf = (header: string, values: string[], min: number): number =>
  Math.max(min, header.length, ...values.map((v) => v.length));

/**
 * The `flui server-types list` table: header, rule, one line per type, and
 * one warning line under it when any type is arm.
 */
export function serverTypeTable(rows: ServerTypeRow[]): string[] {
  const col = {
    id: widthOf(
      'ID',
      rows.map((r) => r.id),
      4,
    ),
    name: widthOf(
      'Name',
      rows.map((r) => r.name),
      6,
    ),
    cpu: widthOf(
      'vCPU',
      rows.map((r) => r.cores),
      4,
    ),
    memory: widthOf(
      'Memory',
      rows.map((r) => r.memory),
      6,
    ),
    disk: widthOf(
      'Disk',
      rows.map((r) => r.disk),
      5,
    ),
    arch: widthOf(
      'Arch',
      rows.map((r) => archLabel(r.architecture)),
      4,
    ),
    available: widthOf(
      'Available',
      rows.map((r) => r.availability.label),
      9,
    ),
    price: widthOf(
      'Price/Month',
      rows.map((r) => r.price),
      11,
    ),
  };

  const header =
    `  ${chalk.bold('ID'.padEnd(col.id))} ${chalk.bold('Name'.padEnd(col.name))} ` +
    `${chalk.bold('vCPU'.padStart(col.cpu))} ${chalk.bold('Memory'.padStart(col.memory))} ` +
    `${chalk.bold('Disk'.padStart(col.disk))} ${chalk.bold('Arch'.padEnd(col.arch))} ` +
    `${chalk.bold('Available'.padEnd(col.available))} ${chalk.bold('Price/Month'.padStart(col.price))} ` +
    chalk.bold('Regions');
  const ruleWidth =
    col.id +
    col.name +
    col.cpu +
    col.memory +
    col.disk +
    col.arch +
    col.available +
    col.price +
    20 +
    8;

  return [
    header,
    chalk.dim('  ' + '─'.repeat(ruleWidth)),
    ...rows.map(
      (row) =>
        `  ${row.id.padEnd(col.id)} ${row.name.padEnd(col.name)} ` +
        `${row.cores.padStart(col.cpu)} ${row.memory.padStart(col.memory)} ` +
        `${row.disk.padStart(col.disk)} ${archCell(row.architecture, col.arch)} ` +
        `${row.availability.color(row.availability.label.padEnd(col.available))} ` +
        `${row.price.padStart(col.price)} ${chalk.dim(row.regions)}`,
    ),
    ...(rows.some((row) => archLabel(row.architecture) === 'arm')
      ? ['', `  ${armWarningLine()}`]
      : []),
  ];
}
