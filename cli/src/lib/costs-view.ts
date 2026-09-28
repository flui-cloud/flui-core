import type {
  CostMonthDto,
  CostProviderDto,
  CostsResponseDto,
} from 'src/modules/infrastructure/clusters/dto/costs.dto';
import { ApiClient } from './api-client';
import { ConfigStorage } from './config-storage';

export class CostsClient {
  constructor(private readonly api: ApiClient) {}

  static open(): CostsClient {
    const storage = new ConfigStorage();
    return new CostsClient(
      new ApiClient({
        baseUrl: storage.getApiUrlOrThrow(),
        apiKey: storage.getApiKeyOrThrow(),
      }),
    );
  }

  get(months?: number): Promise<CostsResponseDto> {
    return this.api.get<CostsResponseDto>(
      months
        ? `/infrastructure/costs?months=${months}`
        : '/infrastructure/costs',
    );
  }
}

/** Two decimals and the currency, the one way every amount is written. */
export function formatMoney(
  value: number | null | undefined,
  currency = 'EUR',
): string {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return '—';
  }
  const fixed = value.toFixed(2);
  return currency === 'EUR' ? `€${fixed}` : `${fixed} ${currency}`;
}

const MONTH_NAMES = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function monthLabel(key: string): string {
  const [year, month] = key.split('-').map(Number);
  return `${MONTH_NAMES[(month ?? 1) - 1]} ${year}`;
}

function vatLine(provider: CostProviderDto): string {
  if (!provider.vatIncluded)
    return 'amounts exclude VAT (the provider publishes no rate)';
  return provider.vatRatePercent !== null
    ? `VAT ${provider.vatRatePercent}% on this account`
    : 'VAT included at the rate of this account';
}

function monthRow(m: CostMonthDto, currency: string, withVat: boolean): string {
  const label = monthLabel(m.month).padEnd(10);
  if (m.current) {
    const vat =
      withVat && m.forecastGross !== null
        ? `  (incl. VAT ${formatMoney(m.forecastGross, currency)})`
        : '';
    return `${label}${formatMoney(m.spentNet, currency).padStart(10)} so far · forecast ${formatMoney(m.forecastNet, currency)}${vat}`;
  }
  const vat =
    withVat && m.spentGross !== null
      ? `  (incl. VAT ${formatMoney(m.spentGross, currency)})`
      : '';
  return `${label}${formatMoney(m.spentNet, currency).padStart(10)}${vat}`;
}

type CostClusterDto = CostProviderDto['clusters'][number];

function hasCost(c: CostClusterDto): boolean {
  return (
    c.months.some((m) => m.spentNet > 0 || (m.forecastNet ?? 0) > 0) ||
    Boolean(c.unpriced)
  );
}

function clusterRow(c: CostClusterDto, currency: string): string {
  const current = c.months.find((m) => m.current);
  const name = `${c.clusterName}${c.removed ? ' (deleted)' : ''}`;
  const figures = current
    ? `${formatMoney(current.spentNet, currency).padStart(10)}  forecast ${formatMoney(current.forecastNet, currency)}`
    : '';
  const unpriced = c.unpriced ? `  · ${c.unpriced} not priced` : '';
  return `    ${name.padEnd(34)}${figures}${unpriced}`;
}

function providerLines(provider: CostProviderDto, currency: string): string[] {
  const out: string[] = [`${provider.provider}`];
  if (!provider.priced) {
    out.push(
      `  ${provider.note ?? 'Not priced.'}`,
      `  ${provider.unpriced} machine(s) and volume(s) counted.`,
      '',
    );
    return out;
  }
  const billedAs = provider.billedAs ? `${provider.billedAs} · ` : '';
  out.push(`  ${billedAs}${vatLine(provider)}`);
  for (const m of provider.months) {
    out.push(`  ${monthRow(m, currency, provider.vatIncluded)}`);
  }
  const withCost = provider.clusters.filter(hasCost);
  if (withCost.length) {
    out.push('  This month, by cluster');
    for (const c of withCost) out.push(clusterRow(c, currency));
  }
  if (provider.listPriced) {
    out.push(
      `  ${provider.listPriced} machine(s) or volume(s) priced at today's list price: they started before Flui kept the price they were bought at.`,
    );
  }
  if (provider.unpriced) {
    out.push(
      `  ${provider.unpriced} machine(s) or volume(s) could not be priced and are left out.`,
    );
  }
  out.push('');
  return out;
}

/** The whole answer as lines of text, the same reading the dashboard gives. */
export function costLines(
  costs: CostsResponseDto,
  providerFilter?: string,
): string[] {
  const out: string[] = [];
  const currency = costs.currency;
  const providers = providerFilter
    ? costs.providers.filter((p) => p.provider === providerFilter)
    : costs.providers;

  if (!costs.providers.length) {
    out.push(
      'No machine has been recorded yet: costs start with the first cluster Flui creates.',
    );
    return out;
  }

  if (providerFilter && !providers.length) {
    out.push(`Nothing recorded on ${providerFilter} in these months.`);
    return out;
  }

  out.push(`Amounts in ${currency}, excluding VAT unless marked.`);
  if (costs.recordedSince) {
    out.push(
      `Recorded since ${new Date(costs.recordedSince).toISOString().slice(0, 10)}; nothing earlier is known.`,
    );
  }
  out.push('');

  if (!providerFilter) {
    out.push('All providers');
    for (const m of costs.totals) out.push(`  ${monthRow(m, currency, true)}`);
    out.push('');
  }

  for (const provider of providers) {
    out.push(...providerLines(provider, currency));
  }

  for (const note of costs.notes) out.push(note);
  return out;
}
