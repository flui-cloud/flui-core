/**
 * A name a manifest spells before the application exists. The deployment
 * templates use `{{SLUG}}` and catalog companions `{{app.slug}}`; the generator
 * fills both with the application's slug, so every check must read both.
 */
export function fillAppSlug(name: string, slug: string): string {
  return name.replaceAll('{{SLUG}}', slug).replaceAll('{{app.slug}}', slug);
}
