import * as express from 'express';
import * as request from 'supertest';
import { DEFAULT_TRUST_PROXY, trustProxySetting } from './trust-proxy.config';

describe('trustProxySetting', () => {
  it('trusts only private and loopback hops when nothing is set', () => {
    expect(trustProxySetting('')).toBe(DEFAULT_TRUST_PROXY);
    expect(trustProxySetting('  ')).toBe(DEFAULT_TRUST_PROXY);
  });

  it('can be turned off', () => {
    expect(trustProxySetting('false')).toBe(false);
  });

  it('reads a hop count as a number and anything else as an address list', () => {
    expect(trustProxySetting('2')).toBe(2);
    expect(trustProxySetting('10.42.0.0/16, 173.245.48.0/20')).toBe(
      '10.42.0.0/16, 173.245.48.0/20',
    );
  });
});

describe('the client address behind the ingress', () => {
  const app = express();
  app.set('trust proxy', trustProxySetting(''));
  app.get('/ip', (req, res) => res.send(req.ip));

  it('is the visitor the ingress names, not the ingress', async () => {
    const res = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '203.0.113.7');
    expect(res.text).toBe('203.0.113.7');
  });

  it('cannot be forged by a visitor writing its own header', async () => {
    const res = await request(app)
      .get('/ip')
      .set('X-Forwarded-For', '198.51.100.1, 203.0.113.7');
    expect(res.text).toBe('203.0.113.7');
  });
});
