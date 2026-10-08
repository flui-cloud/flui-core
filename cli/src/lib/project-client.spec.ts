import { resolveProjectId } from './project-client';

describe('resolveProjectId', () => {
  const projects = [
    { id: 'id-1', name: 'Web team', slug: 'web-team' },
    {
      id: 'id-2',
      name: 'Personal',
      slug: 'personal-6f1c2a9e',
      ownerUserId: 'u1',
    },
    { id: 'id-3', name: 'Data', slug: 'data' },
    { id: 'id-4', name: 'Data', slug: 'data-2' },
  ];

  it('takes a slug or an id as they are', () => {
    expect(resolveProjectId(projects, 'web-team')).toBe('id-1');
    expect(resolveProjectId(projects, 'id-2')).toBe('id-2');
  });

  it('takes a name when it is unambiguous, whatever its case', () => {
    expect(resolveProjectId(projects, 'web TEAM')).toBe('id-1');
  });

  it('asks for the slug when two projects share a name', () => {
    expect(() => resolveProjectId(projects, 'Data')).toThrow(/data, data-2/);
  });

  it('says where to look when nothing matches', () => {
    expect(() => resolveProjectId(projects, 'nope')).toThrow(
      /flui project list/,
    );
  });
});
