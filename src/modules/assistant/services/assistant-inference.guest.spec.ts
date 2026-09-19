// Importing the service for its constructor drags in the resolver and, behind
// it, the provider factory — one package in that chain is ESM. Every collaborator
// here is a stub, so nothing real is ever constructed.
jest.mock('../../inference/services/inference-resolver.service', () => ({
  InferenceResolverService: class InferenceResolverService {},
}));
jest.mock('../../inference/services/inference-client.service', () => ({
  InferenceClientService: class InferenceClientService {},
}));

import { AssistantInferenceService } from './assistant-inference.service';
import { CloudProvider } from '../../providers/enums/cloud-provider.enum';

const INSTANCE_ENDPOINT = {
  baseUrl: 'https://provider.example/v1',
  apiKey: 'instance-key',
  defaultModel: 'model-a',
};

const OTHER_ENDPOINT = {
  baseUrl: 'https://someone-elses.example/v1',
  apiKey: 'their-key',
  defaultModel: 'an-expensive-one',
};

const build = (over: {
  guest: boolean;
  configuredModel?: string;
  spent?: number;
  budget?: string;
  connectionId?: string;
  provider?: string;
  connectionRefuses?: boolean;
}) => {
  const asked: string[] = [];
  const resolver = {
    resolveDefault: async () => {
      asked.push('default');
      return INSTANCE_ENDPOINT;
    },
    resolveNative: async () => {
      asked.push('native');
      return OTHER_ENDPOINT;
    },
    resolveConnection: async () => {
      asked.push('connection');
      if (over.connectionRefuses) throw new Error('not found');
      return OTHER_ENDPOINT;
    },
  };
  const client = { listModelIds: async () => ['whatever'] };
  const config = {
    get: (key: string) =>
      ({
        SANDBOX_ASSISTANT_MODEL: over.configuredModel,
        SANDBOX_INFERENCE_TOKEN_BUDGET: over.budget,
        SANDBOX_INFERENCE_CONNECTION_ID: over.connectionId,
        SANDBOX_INFERENCE_PROVIDER: over.provider,
      })[key],
  };
  const usage = { tokensFor: async () => over.spent ?? 0 };
  const policy = {
    resolveAccess: async () => ({ isSandbox: over.guest }),
  };
  const users = {
    findOne: async () => ({
      id: 'u1',
      email: 'guest-1@example.test',
      role: 'user',
      isAdmin: false,
    }),
  };

  return {
    asked,
    service: new AssistantInferenceService(
      resolver as never,
      client as never,
      config as never,
      policy as never,
      users as never,
      usage as never,
    ),
  };
};

const principal = { userId: 'u1' };

describe('what a sandbox guest may choose about inference', () => {
  /**
   * Three things are taken away, and the instance pays for all three. The
   * interface hides the model picker for a guest; this is what makes hiding it
   * honest rather than decorative, because the picker is not the only way in.
   */
  it('ignores a model named in the request', async () => {
    const { service } = build({ guest: true, configuredModel: 'small-cheap' });

    const { endpoint } = await service.resolveEndpoint(
      { model: 'an-expensive-one' },
      principal,
    );
    const model = await service.resolveModel(
      { model: 'an-expensive-one' },
      endpoint,
    );

    expect(model).toBe('small-cheap');
  });

  it('ignores a provider named in the request', async () => {
    const { service, asked } = build({ guest: true });

    const { endpoint } = await service.resolveEndpoint(
      { provider: CloudProvider.SCALEWAY },
      principal,
    );

    expect(asked).toEqual(['default']);
    expect(endpoint.baseUrl).toBe(INSTANCE_ENDPOINT.baseUrl);
  });

  /**
   * The least obvious of the three: a connection with no owner belongs to the
   * installation and `canSpend` lets anyone spend it — right for a colleague,
   * wrong for a visitor who arrived a minute ago.
   */
  it('ignores a connection named in the request', async () => {
    const { service, asked } = build({ guest: true });

    const { endpoint } = await service.resolveEndpoint(
      { connectionId: 'someone-elses' },
      principal,
    );

    expect(asked).toEqual(['default']);
    expect(endpoint.apiKey).toBe(INSTANCE_ENDPOINT.apiKey);
  });

  it('falls back to the endpoint’s own default when no model is configured', async () => {
    const { service } = build({ guest: true });

    const { endpoint } = await service.resolveEndpoint({}, principal);
    const model = await service.resolveModel({}, endpoint);

    expect(model).toBe(INSTANCE_ENDPOINT.defaultModel);
  });

  it('says which model a guest was given, so a log can show it', async () => {
    const { service } = build({ guest: true, configuredModel: 'small-cheap' });

    const { source } = await service.resolveEndpoint({}, principal);

    expect(source).toBe('guest:small-cheap');
  });

  // The other half: nothing changes for a person who is not a guest.
  it('leaves a member’s own choice alone', async () => {
    const { service, asked } = build({ guest: false });

    const { endpoint } = await service.resolveEndpoint(
      { connectionId: 'mine' },
      principal,
    );
    const model = await service.resolveModel({ model: 'mine-too' }, endpoint);

    expect(asked).toEqual(['connection']);
    expect(model).toBe('mine-too');
  });

  /**
   * Checked before the call and not after, because a budget checked afterwards
   * is always overspent by exactly one turn — and that turn is the expensive
   * one, the one reading a long log back.
   */
  it('closes the door when the area has spent its share', async () => {
    const { service } = build({ guest: true, budget: '1000', spent: 1000 });

    await expect(service.resolveEndpoint({}, principal)).rejects.toMatchObject({
      response: { code: 'SANDBOX_INFERENCE_BUDGET_SPENT' },
    });
  });

  it('says what is left, for the ring on screen', async () => {
    const { service } = build({ guest: true, budget: '1000', spent: 250 });

    await expect(service.guestUsage('u1')).resolves.toEqual({
      spent: 250,
      budget: 1000,
    });
  });

  it('marks who is spending, so the ledger has an owner', async () => {
    const { service } = build({ guest: true });

    const { endpoint } = await service.resolveEndpoint(
      {},
      principal,
      'console:db',
    );

    expect(endpoint.spender).toEqual({
      userId: 'u1',
      guest: true,
      surface: 'console:db',
    });
  });

  /**
   * `resolveDefault` walks the inference-capable providers first and takes the
   * first one holding a credential — Scaleway, on most installations. So an
   * operator who attached an account for their visitors and marked it default
   * would still see Scaleway in the usage report, with nothing to explain why.
   * The instance names its choice instead.
   */
  it('uses the connection the instance named, not whatever resolution finds first', async () => {
    const { service, asked } = build({ guest: true, connectionId: 'chosen' });

    const { endpoint } = await service.resolveEndpoint({}, principal);

    expect(asked).toEqual(['connection']);
    expect(endpoint.baseUrl).toBe(OTHER_ENDPOINT.baseUrl);
  });

  it('uses the native provider the instance named', async () => {
    const { service, asked } = build({ guest: true, provider: 'scaleway' });

    await service.resolveEndpoint({}, principal);

    expect(asked).toEqual(['native']);
  });

  it('keeps the old behaviour when the instance named nothing', async () => {
    const { service, asked } = build({ guest: true });

    await service.resolveEndpoint({}, principal);

    expect(asked).toEqual(['default']);
  });

  // A personal connection named for guests would otherwise show every visitor a
  // bare 404 while the row sits in the operator's list looking fine.
  it('says why when the named connection cannot be spent by a guest', async () => {
    const { service } = build({
      guest: true,
      connectionId: 'someone-elses',
      connectionRefuses: true,
    });

    await expect(service.resolveEndpoint({}, principal)).rejects.toThrow(
      /belongs to the installation rather than to a person/,
    );
  });
});
