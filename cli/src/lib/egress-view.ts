export interface EgressPort {
  port: number;
  protocol: 'TCP' | 'UDP';
}

export interface EgressView {
  open: boolean;
  ports: EgressPort[];
  summary: string;
}

export interface EgressChange extends EgressView {
  applied: number;
  failed: Array<{ namespace: string; error: string }>;
}

/** `80, 443, 53/udp` → ports; TCP unless a protocol follows a slash. */
export function parseEgressPorts(spec: string): EgressPort[] {
  const ports: EgressPort[] = [];
  for (const raw of spec.split(',')) {
    const entry = raw.trim();
    if (!entry) continue;
    const [num, proto = 'tcp'] = entry.split('/');
    const port = Number(num);
    const protocol = proto.trim().toUpperCase();
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new Error(`"${entry}" is not a port between 1 and 65535`);
    }
    if (protocol !== 'TCP' && protocol !== 'UDP') {
      throw new Error(`"${entry}": the protocol must be tcp or udp`);
    }
    ports.push({ port, protocol });
  }
  return ports;
}
