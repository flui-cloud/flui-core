jest.mock('@kubernetes/client-node', () => ({}));
jest.mock('@octokit/rest', () => ({ Octokit: class {} }));
jest.mock('@octokit/auth-app', () => ({ createAppAuth: () => undefined }));

import { ApplicationsModule } from './applications.module';
import { IamModule } from '../iam/iam.module';

/**
 * The guard that decides who may open a console on a platform row asks IAM
 * whether the caller holds authority at GLOBAL scope. It can only ask if
 * POLICY_ENGINE is resolvable where that guard is provided, and it is provided
 * in DatabaseConsoleModule, which imports this module and not IamModule.
 *
 * A missing re-export does not fail the build and does not fail a unit test
 * that hands the guard a fake engine: it fails at boot, on the live instance.
 * So the wiring is pinned here rather than assumed.
 */
describe('IAM reaches the modules that import applications', () => {
  it('re-exports IamModule, so POLICY_ENGINE resolves downstream', () => {
    const imports = Reflect.getMetadata('imports', ApplicationsModule) ?? [];
    const exports = Reflect.getMetadata('exports', ApplicationsModule) ?? [];

    expect(imports).toContain(IamModule);
    expect(exports).toContain(IamModule);
  });
});
