import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * The gate that says "GitHub is connected" has to answer for *this* caller.
 *
 * `listInstallations()` returns every installation the instance tracks, so a
 * gate built on it says yes to a caller who reaches none of them and then
 * fails downstream, where the message is about a build rather than a missing
 * connection. Reaching for the unscoped list here is the same shape of defect
 * the installation resolver was fixed for: a gate that answers about the
 * instance when it was asked about a person.
 */
describe('the deploy gate asks whether *this* user reaches an installation', () => {
  const source = readFileSync(
    join(__dirname, 'application-source-deploy.service.ts'),
    'utf8',
  );

  it('never asks for every installation the instance tracks', () => {
    expect(source).not.toContain('listInstallations(');
  });

  it('asks which installations the caller reaches, by user', () => {
    expect(source).toContain('listReachableInstallations(userId)');
  });
});
