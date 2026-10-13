jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: jest.fn() }));
jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('jwks-rsa', () => ({ JwksClient: jest.fn() }));
jest.mock('jose', () => ({}));

const controllersWith = (flag: string | undefined): string[] => {
  const before = process.env.SANDBOX_VISITOR_TEST_ROUTE;
  if (flag === undefined) delete process.env.SANDBOX_VISITOR_TEST_ROUTE;
  else process.env.SANDBOX_VISITOR_TEST_ROUTE = flag;
  let names: string[] = [];
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- the module reads the flag as it loads, so it is loaded once per flag
    const { SandboxModule } = require('./sandbox.module');
    names = (
      Reflect.getMetadata('controllers', SandboxModule) as Array<{
        name: string;
      }>
    ).map((c) => c.name);
  });
  if (before === undefined) delete process.env.SANDBOX_VISITOR_TEST_ROUTE;
  else process.env.SANDBOX_VISITOR_TEST_ROUTE = before;
  return names;
};

describe('the visitor test route', () => {
  it('is not even registered unless switched on', () => {
    expect(controllersWith(undefined)).not.toContain(
      'SandboxVisitorTestController',
    );
    expect(controllersWith('1')).not.toContain('SandboxVisitorTestController');
    expect(controllersWith('true')).toContain('SandboxVisitorTestController');
  });

  it('always registers the visitors’ entrance', () => {
    expect(controllersWith(undefined)).toContain('SandboxVisitorController');
  });
});
