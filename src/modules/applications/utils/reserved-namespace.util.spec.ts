import { BadRequestException } from '@nestjs/common';
import {
  assertPlaceableNamespace,
  isReservedNamespace,
  isValidNamespaceName,
  RESERVED_NAMESPACE_ERROR_CODE,
  INVALID_NAMESPACE_ERROR_CODE,
} from './reserved-namespace.util';
import { buildUserNamespace } from './k8s-namespace.util';

const codeOf = (ns: string): string => {
  try {
    assertPlaceableNamespace(ns);
  } catch (e) {
    const body = (e as BadRequestException).getResponse() as { code: string };
    return body.code;
  }
  return 'ACCEPTED';
};

describe('isReservedNamespace', () => {
  it.each([
    'kube-system',
    'kube-public',
    'kube-node-lease',
    'flui-system',
    'flui-control',
    'flui-build',
    'flui-observability',
    'flui-local-storage',
    'flui-monitoring',
    'build-agents',
    'cert-manager',
    'velero',
  ])('reserves the platform namespace %s', (ns) => {
    expect(isReservedNamespace(ns)).toBe(true);
  });

  it('reserves namespaces that do not exist yet but claim a platform prefix', () => {
    expect(isReservedNamespace('flui-anything')).toBe(true);
    expect(isReservedNamespace('kube-anything')).toBe(true);
  });

  it('is case- and whitespace-insensitive, so casing cannot smuggle a name through', () => {
    expect(isReservedNamespace('FLUI-System')).toBe(true);
    expect(isReservedNamespace('  kube-system  ')).toBe(true);
  });

  it.each(['default', 'user-dawit', 'my-app', 'fluid', 'kubernetes'])(
    'leaves %s placeable',
    (ns) => {
      expect(isReservedNamespace(ns)).toBe(false);
    },
  );

  it('never reserves a namespace derived from a user email', () => {
    expect(isReservedNamespace(buildUserNamespace('flui-system@x.com'))).toBe(
      false,
    );
    expect(isReservedNamespace(buildUserNamespace('kube-system@x.com'))).toBe(
      false,
    );
  });
});

describe('isValidNamespaceName', () => {
  it.each(['a', 'user-dawit', 'my-app-1'])('accepts %s', (ns) => {
    expect(isValidNamespaceName(ns)).toBe(true);
  });

  it.each([
    '',
    'UPPER',
    '-leading',
    'trailing-',
    'under_score',
    'dot.ted',
    'has space',
    'a'.repeat(64),
  ])('rejects %s', (ns) => {
    expect(isValidNamespaceName(ns)).toBe(false);
  });
});

describe('assertPlaceableNamespace', () => {
  it('accepts an ordinary namespace', () => {
    expect(() => assertPlaceableNamespace('user-dawit')).not.toThrow();
  });

  it('refuses a reserved namespace with a structured code', () => {
    expect(codeOf('flui-system')).toBe(RESERVED_NAMESPACE_ERROR_CODE);
    expect(codeOf('kube-system')).toBe(RESERVED_NAMESPACE_ERROR_CODE);
  });

  it('refuses a malformed name before it can reach the cluster', () => {
    expect(codeOf('Not A Namespace')).toBe(INVALID_NAMESPACE_ERROR_CODE);
    expect(codeOf('../../flui-system')).toBe(INVALID_NAMESPACE_ERROR_CODE);
  });

  it('refuses reserved names dressed up with casing or padding', () => {
    expect(codeOf('FLUI-SYSTEM')).toBe(INVALID_NAMESPACE_ERROR_CODE);
    expect(codeOf(' flui-system')).toBe(INVALID_NAMESPACE_ERROR_CODE);
  });
});
