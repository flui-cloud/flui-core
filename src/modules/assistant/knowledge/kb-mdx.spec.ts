import {
  cleanMdx,
  leftoverComponents,
  stripHtmlComments,
} from '../../../../scripts/kb-mdx';

describe('kb-mdx cleaning', () => {
  it('drops imports and turns tabs into labelled text', () => {
    const out = cleanMdx(
      [
        "import { Tabs, TabItem } from '@astrojs/starlight/components';",
        "import Screenshot from '../../../components/Screenshot.astro';",
        '',
        '## Deploy',
        '',
        '<Tabs syncKey="surface">',
        '<TabItem label="CLI">',
        '',
        'Run `flui deploy`.',
        '',
        '</TabItem>',
        '<TabItem label="Dashboard">',
        '',
        'Open **Deploy**.',
        '',
        '</TabItem>',
        '</Tabs>',
      ].join('\n'),
    );
    expect(out).toBe(
      [
        '## Deploy',
        '',
        '**CLI:**',
        '',
        'Run `flui deploy`.',
        '',
        '**Dashboard:**',
        '',
        'Open **Deploy**.',
      ].join('\n'),
    );
  });

  it('keeps the caption of a multi-line component and ignores nested quotes', () => {
    const out = cleanMdx(
      [
        '<Topology',
        '  control={{ on: \'byos\', label: "x" }}',
        "  clusters={[{ on: 'hetzner', servers: [3, 2] }]}",
        '  caption="One installation across providers"',
        '/>',
        '',
        '   <Screenshot light={a} dark={b} alt="The review step." />',
      ].join('\n'),
    );
    expect(out).toBe(
      [
        '_Diagram: One installation across providers._',
        '',
        '   _Screenshot: The review step._',
      ].join('\n'),
    );
  });

  it('drops a self-closing component with no text and keeps link cards', () => {
    expect(
      cleanMdx('<Divider />\n\n<LinkCard title="Next" description="Go on" />'),
    ).toBe('**Next**: Go on.');
  });

  it('never touches fenced or inline code', () => {
    const src = [
      'Set `flui app env set <app> <KEY>` here.',
      '',
      '```tsx',
      'import X from "y";',
      '<Tabs><!-- keep --></Tabs>',
      '```',
    ].join('\n');
    expect(cleanMdx(src)).toBe(src);
    expect(leftoverComponents(src)).toEqual([]);
  });

  it('strips HTML comments outside code only', () => {
    const src = 'a <!-- evidence: x.ts:1 --> b\n\n```html\n<!-- kept -->\n```';
    expect(stripHtmlComments(src)).toBe('a  b\n\n```html\n<!-- kept -->\n```');
  });

  it('reports an unknown paired component instead of dropping it', () => {
    const out = cleanMdx('<Badge text="new">beta</Badge>');
    expect(leftoverComponents(out)).toEqual(['<Badge', '</Badge']);
  });
});
