import { unansweredMessage } from './api-client';

describe('a request that got no answer', () => {
  const config = {
    baseURL: 'https://api.example.com/api/v1',
    url: '/catalog/install',
    timeout: 30000,
  };

  it('says a slow request timed out and may still be running, not that the API is unreachable', () => {
    const text = unansweredMessage({
      code: 'ECONNABORTED',
      message: 'timeout of 30000ms exceeded',
      config,
    } as any);
    expect(text).toContain('did not answer');
    expect(text).toContain('30 seconds');
    expect(text).toContain('may still be running');
  });

  it('says unreachable only when the connection itself failed', () => {
    expect(
      unansweredMessage({ code: 'ECONNREFUSED', message: 'x', config } as any),
    ).toContain('cannot be reached');
  });

  it('keeps the real cause for anything else', () => {
    expect(
      unansweredMessage({
        code: 'ECONNRESET',
        message: 'socket hang up',
        config,
      } as any),
    ).toContain('ECONNRESET: socket hang up');
  });
});
