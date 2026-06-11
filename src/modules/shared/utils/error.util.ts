import axios, { AxiosError } from 'axios';

/** Best-effort readable string from an axios error body (string, {message|error}, or JSON). */
function describeAxiosBody(error: AxiosError): string {
  const data = error.response?.data;
  if (typeof data === 'string') return data;
  if (data && typeof data === 'object') {
    const obj = data as { message?: unknown; error?: unknown };
    const m = obj.message ?? obj.error;
    if (typeof m === 'string') return m;
    return JSON.stringify(m ?? data);
  }
  return error.message;
}

/**
 * A short, human-readable description of an error — never the raw object.
 * For axios errors it surfaces the HTTP status and the upstream body message
 * (e.g. a provider quota error) instead of dumping the whole request/socket.
 */
export function describeError(error: unknown, context?: string): string {
  let detail: string;
  if (axios.isAxiosError(error)) {
    const status = error.response?.status;
    const prefix = status ? `[${status}] ` : '';
    detail = `${prefix}${describeAxiosBody(error)}`;
  } else if (error instanceof Error) {
    detail = error.message;
  } else if (typeof error === 'string') {
    detail = error;
  } else {
    detail = JSON.stringify(error);
  }
  return context ? `${context}: ${detail}` : detail;
}
