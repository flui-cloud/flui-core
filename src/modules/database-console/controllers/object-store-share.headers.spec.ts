import { shareResponseHeaders } from './object-store-share.headers';

/** F-092: a share link must never run a guest's page on the API origin. */
describe('what a share link is served as', () => {
  it.each([
    'text/html',
    'image/svg+xml',
    'application/xhtml+xml',
    'text/javascript',
    'application/xml',
    undefined,
  ])('hands %s over as a download that cannot run', (type) => {
    const headers = shareResponseHeaders(type, false, 'page.html');
    expect(headers['Content-Type']).toBe('application/octet-stream');
    expect(headers['Content-Disposition']).toMatch(/^attachment;/);
    expect(headers['X-Content-Type-Options']).toBe('nosniff');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
  });

  it('still previews an image in place, sandboxed', () => {
    const headers = shareResponseHeaders('image/png', false, 'cat.png');
    expect(headers['Content-Type']).toBe('image/png');
    expect(headers['Content-Disposition']).toBe('inline; filename="cat.png"');
    expect(headers['Content-Security-Policy']).toContain('sandbox');
  });

  it('downloads a previewable file when asked', () => {
    expect(
      shareResponseHeaders('image/png', true, 'cat.png')['Content-Disposition'],
    ).toMatch(/^attachment;/);
  });

  it('reads the declared type without its parameters or case', () => {
    expect(
      shareResponseHeaders('Text/HTML; charset=utf-8', false, 'x')[
        'Content-Type'
      ],
    ).toBe('application/octet-stream');
    expect(
      shareResponseHeaders('text/plain; charset=latin1', false, 'x')[
        'Content-Type'
      ],
    ).toBe('text/plain; charset=utf-8');
  });

  it('keeps the file name from breaking the header', () => {
    expect(
      shareResponseHeaders('image/png', false, 'a"\r\nSet-Cookie: x.png')[
        'Content-Disposition'
      ],
    ).toBe('inline; filename="aSet-Cookie: x.png"');
  });
});
