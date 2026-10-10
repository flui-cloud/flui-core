import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateApplicationDto } from '../dto/create-application.dto';
import { secretReferenceProblems } from './secret-reference.policy';

/** F-098: an application reads only its own Secrets and those of its owner's other applications. */
describe('which Secrets an application may read', () => {
  const app = (over: Record<string, unknown> = {}) =>
    ({
      slug: 'shop',
      userId: 'u1',
      projectId: 'p1',
      k8sNamespace: 'guest-1',
      env: [],
      ...over,
    }) as never;
  const ref = (secretName: string) => ({
    env: [
      { name: 'X', value: '', externalSecretRef: { secretName, key: 'k' } },
    ],
  });
  const neighbours = [
    {
      slug: 'postgresql-abc',
      userId: 'u1',
      projectId: 'p1',
      k8sNamespace: 'guest-1',
    },
    {
      slug: 'mates-db',
      userId: 'u2',
      projectId: 'p1',
      k8sNamespace: 'guest-1',
    },
    {
      slug: 'stranger-db',
      userId: 'u3',
      projectId: 'p9',
      k8sNamespace: 'guest-1',
    },
    { slug: 'far-db', userId: 'u1', projectId: 'p1', k8sNamespace: 'other' },
  ];

  it('reads its own Secret and a building block of the same owner or project', () => {
    expect(
      secretReferenceProblems(app(ref('shop-secret')), neighbours),
    ).toEqual([]);
    expect(
      secretReferenceProblems(app(ref('postgresql-abc-secret')), neighbours),
    ).toEqual([]);
    expect(
      secretReferenceProblems(app(ref('mates-db-secret')), neighbours),
    ).toEqual([]);
  });

  it.each([
    'wildcard-example-com-tls',
    'kopia-snap-296e468640ddefa3df6e-secret',
    'ghcr-pull-secret',
    'stranger-db-secret',
    'far-db-secret',
  ])('refuses %s', (name) => {
    expect(secretReferenceProblems(app(ref(name)), neighbours)).toHaveLength(1);
  });

  it('lets a companion read only its own application’s Secrets', () => {
    const companions = (secretName: string) => ({
      companions: {
        sidecars: [
          {
            name: 'backup',
            image: 'x',
            env: [{ name: 'K', secretRef: { name: secretName, key: 'k' } }],
          },
        ],
        volumes: [{ name: 'creds', secret: { secretName } }],
      },
    });
    expect(
      secretReferenceProblems(app(companions('{{SLUG}}-kopia')), neighbours),
    ).toEqual([]);
    expect(
      secretReferenceProblems(
        app(companions('wildcard-example-com-tls')),
        neighbours,
      ),
    ).toHaveLength(2);
  });

  it('keeps people from naming an application the way platform objects are named', () => {
    const errors = validateSync(
      plainToInstance(CreateApplicationDto, {
        name: 'x',
        slug: 'kopia-snap-296e',
      }),
    ).filter((e) => e.property === 'slug');
    expect(errors).not.toHaveLength(0);
  });
});
