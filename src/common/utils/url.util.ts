/**
 * Drop trailing slashes without a regex: `/\/+$/` backtracks super-linearly on
 * a long run of slashes, which an origin header controls.
 */
export function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value[end - 1] === '/') end--;
  return value.slice(0, end);
}
