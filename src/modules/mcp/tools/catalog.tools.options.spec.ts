import { CATALOG_TOOLS } from './catalog.tools';

describe('catalog options for an agent', () => {
  it('shows the switches an app declares, so an agent can install PostgreSQL without the pooler', () => {
    const getApp = CATALOG_TOOLS.find((t) => t.name === 'catalog_get_app')!;
    const projected = getApp.forModel!({
      name: 'PostgreSQL',
      slug: 'postgresql',
      options: [
        {
          key: 'pooler',
          label: 'Connection pooler',
          default: true,
          description: 'd',
        },
        {
          key: 'poolerSessionMode',
          label: 'Session pooling',
          default: false,
          requires: 'pooler',
        },
      ],
    }) as { options: unknown };
    expect(projected.options).toEqual([
      { key: 'pooler', default: true, description: 'd' },
      {
        key: 'poolerSessionMode',
        default: false,
        description: undefined,
        requires: 'pooler',
      },
    ]);
  });
});
