import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * F-095: a console talks to whatever answers inside a guest's application, so a
 * redirect from it would send the API's own request somewhere the guest chose.
 * Every HTTP client a console builds refuses to follow one.
 */
describe('console HTTP clients never follow a redirect', () => {
  const root = join(__dirname, '..');
  const sources = ['engine', 'services']
    .flatMap((dir) =>
      readdirSync(join(root, dir)).map((f) => join(root, dir, f)),
    )
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.spec.ts'));

  it.each(
    sources.filter((f) => readFileSync(f, 'utf8').includes('axios.create(')),
  )('%s', (file) => {
    const source = readFileSync(file, 'utf8');
    const clients = source.split('axios.create(').slice(1);
    for (const client of clients) {
      expect(client.slice(0, client.indexOf('})'))).toContain(
        'maxRedirects: 0',
      );
    }
  });
});
