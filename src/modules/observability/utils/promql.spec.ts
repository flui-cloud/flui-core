jest.mock('@kubernetes/client-node', () => ({}));

import { BadRequestException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import { CreateApplicationDto } from '../../applications/dto/create-application.dto';
import { rawCpuExpressions } from '../services/application-metrics.service';
import { promRegexLiteral, promString } from './promql';
import { ServerIdPipe } from './server-id.pipe';

/** F-096: a slug or a node id must never widen the query it is placed in. */
describe('values placed into PromQL', () => {
  const hostile = 'web",namespace=~".+';

  it('stay inside their own string', () => {
    expect(`{a="${promString(hostile)}"}`).toBe(
      '{a="web\\",namespace=~\\".+"}',
    );
    expect(promString('a\\"\nb')).toBe('a\\\\\\"\\nb');
  });

  it('match literally inside a regex matcher', () => {
    expect(promRegexLiteral('a.b|c')).toBe('a\\\\.b\\\\|c');
  });

  it('keep a hostile slug to one label matcher in the raw CPU queries', () => {
    const { usage } = rawCpuExpressions('guest-1', hostile, '');
    expect(usage).not.toContain(
      `label_app_kubernetes_io_name="web",namespace=~".+"`,
    );
    expect(usage).toContain(
      `label_app_kubernetes_io_name="${promString(hostile)}"`,
    );
  });

  it('refuse a node id that is not an identifier', () => {
    const pipe = new ServerIdPipe();
    expect(pipe.transform('node-1.example:9100')).toBe('node-1.example:9100');
    expect(pipe.transform(undefined)).toBeUndefined();
    expect(() => pipe.transform('x",cluster_id=~".+')).toThrow(
      BadRequestException,
    );
  });

  it('refuse a slug Kubernetes would not take, at creation', () => {
    const errors = (slug: string) =>
      validateSync(
        plainToInstance(CreateApplicationDto, { name: 'web', slug }),
      ).filter((e) => e.property === 'slug');
    expect(errors('web-1')).toHaveLength(0);
    expect(errors(hostile)).not.toHaveLength(0);
    expect(errors('Web')).not.toHaveLength(0);
  });
});
