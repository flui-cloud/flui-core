import type { TopologyResponseDto } from '../../../../src/modules/topology/dto/topology.dto';
import type { Paint } from './topology-format';

export type Snapshot = TopologyResponseDto;

export type TopologyScreen =
  | { type: 'fleet' }
  | { type: 'cluster'; id: string }
  | { type: 'platform'; id: string }
  | { type: 'app'; id: string }
  | { type: 'server'; id: string };

export interface TopologyEntry {
  key: string;
  line: string;
  target: TopologyScreen;
  /** Shown under the row: the reason something is wrong, or what opening it leads to. */
  note?: string;
  notePaint?: Paint;
}

export interface TopologySection {
  title: string;
  header?: string;
  entries?: TopologyEntry[];
  lines?: string[];
}

export interface TopologyView {
  trail: string[];
  summary: string[];
  sections: TopologySection[];
}

export interface ViewOptions {
  /** Platform apps one by one instead of one "Flui platform" entry. */
  system: boolean;
}
