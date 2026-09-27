jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jose', () => ({}));
jest.mock('ip-cidr', () => ({}));

import { BillingEstimatorService } from './billing-estimator.service';
import { BackupDestinationsService } from './backup-destinations.service';

describe('what backup storage costs', () => {
  const cost = (dest: any, provider = 'scaleway_object_storage') =>
    (BillingEstimatorService.prototype as any).computeDestinationCost.call(
      {
        destRepo: { findById: async () => dest },
        providerPricingFromEnv: () => null,
      },
      100,
      provider,
      dest ? 'd1' : undefined,
    );

  it('uses the dated Scaleway list price when nothing more specific is known', async () => {
    const r = await cost(null);
    expect(r.centsPerMonth).toBe(161);
    expect(r.pricingSource).toContain('27 Sep 2026');
  });

  it("prefers the destination's own price, and says so", async () => {
    const r = await cost({ costPerGbMonthCents: 2, metadata: {} });
    expect(r).toMatchObject({
      centsPerMonth: 200,
      pricingSource: 'Price set on this destination',
    });
  });

  it('still gives no figure for a provider without a price', async () => {
    const r = await cost(null, 'generic_s3');
    expect(r.centsPerMonth).toBeNull();
  });

  it('goes back to the list price when the owner clears theirs', async () => {
    const updates: any[] = [];
    const service = Object.assign(
      Object.create(BackupDestinationsService.prototype),
      {
        repo: {
          findById: async () => ({
            id: 'd1',
            userId: 'u1',
            provider: 'scaleway_object_storage',
            metadata: {},
          }),
          update: async (_id: string, patch: any) => updates.push(patch),
        },
      },
    );
    service.findById = async () => ({
      id: 'd1',
      userId: 'u1',
      provider: 'scaleway_object_storage',
      metadata: {},
    });
    await service.setCost('d1', 'u1', null);
    expect(updates[0]).toMatchObject({
      costPerGbMonthCents: 1.606,
      metadata: { costSource: 'list-price' },
    });
    await service.setCost('d1', 'u1', 2.5);
    expect(updates[1]).toEqual({ costPerGbMonthCents: 2.5, metadata: {} });
    await expect(service.setCost('d1', 'someone-else', 1)).rejects.toThrow();
  });
});
