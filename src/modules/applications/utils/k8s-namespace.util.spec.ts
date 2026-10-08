import {
  NAMESPACE_OWNER_UNKNOWN_ERROR_CODE,
  ownerUnknown,
  projectNamespace,
} from './k8s-namespace.util';
import { isValidNamespaceName } from './reserved-namespace.util';

describe('projectNamespace', () => {
  it('is the project slug behind a fixed prefix', () => {
    expect(projectNamespace('web-team')).toBe('p-web-team');
  });

  it('stays a valid namespace for the longest slug a project can get', () => {
    expect(isValidNamespaceName(projectNamespace(`${'a'.repeat(50)}-99`))).toBe(
      true,
    );
  });
});

describe('ownerUnknown', () => {
  it('is a server defect with a code, not a guess', () => {
    expect(ownerUnknown().getResponse()).toMatchObject({
      code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE,
    });
  });
});
