import { observabilityIngestPorts } from './observability-ingest';

describe('observabilityIngestPorts', () => {
  afterEach(() => delete process.env.FLUI_OBS_INGEST_NODEPORTS);

  it('names both ingests by default, logs and metrics', () => {
    // Naming only the log ingest admits half the telemetry: metrics pushed to
    // 30428 are dropped at the door, with no error anywhere to say so.
    expect(observabilityIngestPorts().ports).toEqual([30100, 30428]);
  });

  it('refuses anything outside the NodePort range', () => {
    // A typo must never open 22 or 6443, which is why this is a range check and
    // not a parse.
    const { ports, rejected } = observabilityIngestPorts(
      '30100,22,6443,banana',
    );
    expect(ports).toEqual([30100]);
    expect(rejected).toEqual(['22', '6443', 'banana']);
  });

  it('names each port once', () => {
    expect(observabilityIngestPorts('30100,30100').ports).toEqual([30100]);
  });
});
