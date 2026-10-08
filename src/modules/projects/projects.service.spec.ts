jest.mock('@kubernetes/client-node', () => ({}));

import { ConflictException, NotFoundException } from '@nestjs/common';
import {
  PROJECT_MOVE_REFUSED_CODE,
  PROJECT_NOT_EMPTY_CODE,
  ProjectsService,
} from './projects.service';
import { ProjectEntity } from './entities/project.entity';
import { NAMESPACE_OWNER_UNKNOWN_ERROR_CODE } from '../applications/utils/k8s-namespace.util';

type Row = Partial<ProjectEntity> & { id: string };

const build = (
  seed: Row[] = [],
  apps: Array<{ id: string; projectId: string | null; deletedAt?: Date }> = [],
  unreachable: string[] = [],
) => {
  const rows: Row[] = [...seed];
  const spaces = {
    removeAll: jest.fn(async () => ({
      removed: [],
      failed: unreachable.map((cluster) => ({ cluster, error: 'timeout' })),
    })),
  };
  let next = 1;
  const matches = (row: Row, where: Record<string, unknown>) =>
    Object.entries(where).every(
      ([k, v]) => (row as Record<string, unknown>)[k] === v,
    );
  const projects = {
    findOne: async ({ where }: { where: Record<string, unknown> }) =>
      rows.find((r) => matches(r, where)) ?? null,
    count: async ({ where }: { where: Record<string, unknown> }) =>
      rows.filter((r) => matches(r, where)).length,
    create: (data: Partial<ProjectEntity>) => data,
    save: async (data: Partial<ProjectEntity>) => {
      if (
        data.ownerUserId &&
        rows.some((r) => r.ownerUserId === data.ownerUserId && r.id !== data.id)
      ) {
        throw new Error('duplicate key value violates unique constraint');
      }
      const row = { ...data, id: data.id ?? `p${next++}` } as Row;
      rows.push(row);
      return row;
    },
    delete: async (id: string) => {
      const at = rows.findIndex((r) => r.id === id);
      if (at >= 0) rows.splice(at, 1);
      return { affected: at >= 0 ? 1 : 0 };
    },
  };
  const appRepo = {
    count: async ({
      where,
    }: {
      where: { projectId: string; deletedAt?: unknown };
    }) =>
      apps.filter(
        (a) =>
          a.projectId === where.projectId &&
          !('deletedAt' in where && a.deletedAt),
      ).length,
    findOne: async ({ where }: { where: { id: string } }) =>
      apps.find((a) => a.id === where.id) ?? null,
  };
  return {
    service: new ProjectsService(
      projects as never,
      appRepo as never,
      spaces as never,
    ),
    rows,
    spaces,
  };
};

describe('ProjectsService placement', () => {
  it('lands an application in the project asked for, in that project namespace', async () => {
    const { service } = build([
      { id: 'team', slug: 'web-team', name: 'Web team' },
    ]);

    const placement = await service.placementFor({
      projectId: 'team',
      userId: 'u1',
    });

    expect(placement.project.id).toBe('team');
    expect(placement.namespace).toBe('p-web-team');
  });

  it('makes a personal project the first time a person needs one, and reuses it after', async () => {
    const { service, rows } = build();

    const id = '6f1c2a9e-0000-4000-8000-000000000001';
    const first = await service.placementFor({ userId: id });
    const second = await service.placementFor({ userId: id });

    expect(rows).toHaveLength(1);
    expect(first.project.id).toBe(second.project.id);
    expect(first.project.ownerUserId).toBe(id);
    expect(first.namespace).toBe('p-personal-6f1c2a9e');
  });

  it('never puts an email into the name of a personal project', async () => {
    const { service } = build();

    const { project } = await service.placementFor({
      userId: '11111111-2222-4333-8444-555555555555',
    });

    expect(project.name).toBe('Personal');
    expect(project.slug).not.toContain('@');
  });

  it('gives two people two projects even when their ids share a prefix', async () => {
    const { service } = build();

    const a = await service.placementFor({
      userId: 'abcdef12-0000-4000-8000-000000000001',
    });
    const b = await service.placementFor({
      userId: 'abcdef12-0000-4000-8000-000000000002',
    });

    expect(a.namespace).not.toBe(b.namespace);
  });

  it('reads the project the other request made when two first deploys race', async () => {
    const { service, rows } = build();
    const u1 = '99999999-0000-4000-8000-000000000001';
    rows.push({
      id: 'theirs',
      slug: 'personal-99999999',
      ownerUserId: u1,
      name: 'Personal',
    });
    const findOne = jest
      .spyOn(
        (
          service as unknown as {
            projects: { findOne: () => Promise<unknown> };
          }
        ).projects,
        'findOne',
      )
      .mockResolvedValueOnce(null);

    const { project } = await service.placementFor({ userId: u1 });

    expect(project.id).toBe('theirs');
    findOne.mockRestore();
  });

  it('gives a service credential a project of its own, since it owns no personal one', async () => {
    const { service, rows } = build();

    const first = await service.placementFor({ userId: 'cli-bootstrap' });
    const again = await service.placementFor({ userId: 'cli-bootstrap' });

    expect(first.namespace).toBe('p-service-cli-bootstrap');
    expect(first.project.ownerUserId).toBeNull();
    expect(again.project.id).toBe(first.project.id);
    expect(rows).toHaveLength(1);
  });

  it('refuses to place an application for nobody, rather than in "default"', async () => {
    const { service } = build();

    await expect(
      service.placementFor({ userId: undefined }),
    ).rejects.toMatchObject({
      response: { code: NAMESPACE_OWNER_UNKNOWN_ERROR_CODE },
    });
  });

  it('refuses a project that does not exist', async () => {
    const { service } = build();

    await expect(
      service.placementFor({ projectId: 'missing', userId: 'u1' }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('ProjectsService keeps an application in its project', () => {
  it('refuses to move an application to another project', async () => {
    const { service } = build(
      [
        { id: 'a', slug: 'a', name: 'A' },
        { id: 'b', slug: 'b', name: 'B' },
      ],
      [{ id: 'app', projectId: 'a' }],
    );

    await expect(service.assignApp('b', 'app')).rejects.toMatchObject({
      response: { code: PROJECT_MOVE_REFUSED_CODE },
    });
  });

  it('accepts assigning an application to the project it is already in', async () => {
    const { service } = build(
      [{ id: 'a', slug: 'a', name: 'A' }],
      [{ id: 'app', projectId: 'a' }],
    );

    await expect(service.assignApp('a', 'app')).resolves.toBeUndefined();
  });

  it('refuses to take an application out of its project', async () => {
    const { service } = build(
      [{ id: 'a', slug: 'a', name: 'A' }],
      [{ id: 'app', projectId: 'a' }],
    );

    await expect(service.unassignApp('app')).rejects.toBeInstanceOf(
      ConflictException,
    );
  });

  it('refuses to delete a project that still holds applications', async () => {
    const { service, rows } = build(
      [{ id: 'a', slug: 'a', name: 'A' }],
      [{ id: 'app', projectId: 'a' }],
    );

    await expect(service.remove('a')).rejects.toMatchObject({
      response: { code: PROJECT_NOT_EMPTY_CODE },
    });
    expect(rows).toHaveLength(1);
  });

  it('deletes an empty project and its spaces on the clusters', async () => {
    const { service, rows, spaces } = build([
      { id: 'a', slug: 'a', name: 'A' },
    ]);

    await service.remove('a');

    expect(spaces.removeAll).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'a', slug: 'a' }),
    );
    expect(rows).toHaveLength(0);
  });

  it('does not count applications that were deleted', async () => {
    const { service, rows } = build(
      [{ id: 'a', slug: 'a', name: 'A' }],
      [{ id: 'gone', projectId: 'a', deletedAt: new Date() }],
    );

    await service.remove('a');

    expect(rows).toHaveLength(0);
  });

  it('keeps the project, and its name taken, while a space could not be removed', async () => {
    const { service, rows } = build(
      [{ id: 'a', slug: 'a', name: 'A' }],
      [],
      ['production'],
    );

    await expect(service.remove('a')).rejects.toMatchObject({
      response: { code: 'PROJECT_SPACE_NOT_REMOVED' },
    });
    expect(rows).toHaveLength(1);
  });
});
