const PREVIEWABLE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/plain',
  'audio/mpeg',
  'audio/ogg',
  'audio/wav',
  'video/mp4',
  'video/webm',
]);

/**
 * The headers a share link is served with. The link is opened on the API's own
 * origin, where a browser carries the platform session, so only types that
 * cannot run script are shown in place; anything else, HTML and SVG included,
 * is handed over as a download whatever type the uploader declared.
 */
export function shareResponseHeaders(
  declaredType: string | undefined,
  download: boolean,
  fileName: string,
): Record<string, string> {
  const type = (declaredType ?? '').split(';')[0].trim().toLowerCase();
  const inline = !download && PREVIEWABLE.has(type);
  const safeName = fileName.replaceAll(/["\\\r\n]/g, '') || 'download';
  let contentType = 'application/octet-stream';
  if (inline) {
    contentType = type === 'text/plain' ? 'text/plain; charset=utf-8' : type;
  }
  return {
    'Content-Type': contentType,
    'Content-Disposition': `${inline ? 'inline' : 'attachment'}; filename="${safeName}"`,
    'X-Content-Type-Options': 'nosniff',
    ...(type === 'application/pdf' && inline
      ? {}
      : { 'Content-Security-Policy': "default-src 'none'; sandbox" }),
    'Cross-Origin-Resource-Policy': 'same-origin',
    'Referrer-Policy': 'no-referrer',
  };
}
