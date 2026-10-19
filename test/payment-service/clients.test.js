import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import { createHttpGateway } from '../../src/payment-service/gateway.js';
import { createOrderClient } from '../../src/payment-service/orderClient.js';
import { UpstreamError, withRetry } from '../../src/shared/retry.js';
import { createEncryptedSecretsManager, decryptSecret, encryptSecret } from '../../src/shared/secrets.js';

const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

describe('withRetry', () => {
  it('retries retryable errors up to the attempt limit with exponential backoff', async () => {
    const sleeps = [];
    let calls = 0;
    await assert.rejects(
      withRetry(
        async () => {
          calls++;
          throw new UpstreamError('boom', { retryable: true });
        },
        { attempts: 3, baseDelayMs: 100, factor: 2 },
        { sleep: async (ms) => sleeps.push(ms) },
      ),
      (err) => err.attempts === 3,
    );
    assert.equal(calls, 3);
    assert.deepEqual(sleeps, [100, 200]);
  });

  it('does not retry non-retryable errors', async () => {
    let calls = 0;
    await assert.rejects(
      withRetry(async () => {
        calls++;
        throw new UpstreamError('bad request', { status: 400 });
      }),
    );
    assert.equal(calls, 1);
  });
});

describe('encrypted secrets manager', () => {
  const masterKey = randomBytes(32).toString('base64');

  it('round-trips and never contains the plaintext in the sealed value', () => {
    const sealed = encryptSecret('{"key_id":"a","key_secret":"very-secret"}', masterKey);
    assert.ok(!sealed.includes('very-secret'));
    assert.equal(decryptSecret(sealed, masterKey), '{"key_id":"a","key_secret":"very-secret"}');
  });

  it('rejects a tampered ciphertext or wrong key', () => {
    const sealed = encryptSecret('x', masterKey);
    assert.throws(() => decryptSecret(sealed, randomBytes(32).toString('base64')));
    const parts = sealed.split('.');
    parts[3] = Buffer.from('y').toString('base64url');
    assert.throws(() => decryptSecret(parts.join('.'), masterKey));
  });

  it('ships only sealed gateway credentials in the sample config (REQ-011, NFR-002)', async () => {
    const env = Object.fromEntries(
      (await readFile(new URL('../../.env.example', import.meta.url), 'utf8'))
        .split('\n')
        .filter((line) => /^[A-Z_]+=/.test(line))
        .map((line) => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)]),
    );
    const sealed = env.PAYMENT_GATEWAY_CREDENTIALS_ENCRYPTED;
    assert.match(sealed, /^v1\./);
    const { keyId, keySecret } = await createEncryptedSecretsManager({
      encryptedGatewayCredentials: sealed,
      masterKey: env.SECRETS_MASTER_KEY,
    }).getGatewayCredentials();
    for (const file of ['../../.env.example', '../../docker-compose.yml']) {
      const text = await readFile(new URL(file, import.meta.url), 'utf8');
      assert.ok(!text.includes(keySecret), `${file} contains the plaintext gateway secret`);
      assert.ok(!text.includes(keyId), `${file} contains the plaintext gateway key id`);
    }
  });

  it('decrypts gateway credentials on demand', async () => {
    const secrets = createEncryptedSecretsManager({
      encryptedGatewayCredentials: encryptSecret(JSON.stringify({ key_id: 'id', key_secret: 'sec' }), masterKey),
      masterKey,
    });
    assert.deepEqual(await secrets.getGatewayCredentials(), { keyId: 'id', keySecret: 'sec' });
  });
});

describe('HTTP gateway adapter', () => {
  const payment = { id: 'p-1', order_id: 'o-1', amount: 500, currency: 'INR', payment_method: 'upi' };
  const credentials = { keyId: 'kid', keySecret: 'ksec' };
  const expiresAt = new Date('2026-10-19T10:15:00.000Z');

  it('sends an authenticated, idempotent checkout request and maps the response', async () => {
    let seen;
    const gateway = createHttpGateway({
      name: 'stripe',
      baseUrl: 'https://gw.example/',
      fetchImpl: async (url, init) => {
        seen = { url, init };
        return json(201, { id: 'cs_1', transaction_id: 'txn_1', checkout_url: 'https://pay/cs_1' });
      },
    });
    const session = await gateway.createCheckoutSession({ credentials, payment, expiresAt });
    assert.deepEqual(session, { gatewaySessionId: 'cs_1', gatewayReference: 'txn_1', checkoutUrl: 'https://pay/cs_1' });
    assert.equal(seen.url, 'https://gw.example/checkout/sessions');
    assert.equal(seen.init.headers.authorization, `Basic ${Buffer.from('kid:ksec').toString('base64')}`);
    assert.equal(seen.init.headers['idempotency-key'], 'p-1');
    assert.deepEqual(JSON.parse(seen.init.body), {
      reference: 'p-1',
      order_id: 'o-1',
      amount: 500,
      currency: 'INR',
      payment_method: 'upi',
      expires_at: expiresAt.toISOString(),
    });
  });

  it('marks 5xx and network errors retryable and 4xx not retryable', async () => {
    const make = (fetchImpl) => createHttpGateway({ name: 'stripe', baseUrl: 'https://gw', fetchImpl });
    await assert.rejects(make(async () => json(503, {})).createCheckoutSession({ credentials, payment, expiresAt }), {
      retryable: true,
      status: 503,
    });
    await assert.rejects(
      make(async () => {
        throw new TypeError('fetch failed');
      }).createCheckoutSession({ credentials, payment, expiresAt }),
      { retryable: true },
    );
    await assert.rejects(make(async () => json(400, {})).createCheckoutSession({ credentials, payment, expiresAt }), {
      retryable: false,
      status: 400,
    });
  });
});

describe('order-service client', () => {
  it('returns null on 404 and retries transient failures', async () => {
    const statuses = [503, 200];
    const client = createOrderClient({
      baseUrl: 'http://orders',
      token: 't',
      retryPolicy: { attempts: 3, baseDelayMs: 0 },
      fetchImpl: async (url, init) => {
        assert.equal(init.headers.authorization, 'Bearer t');
        return json(statuses.shift(), { id: 'o', total_amount: 1 });
      },
    });
    assert.deepEqual(await client.getOrder('o'), { id: 'o', total_amount: 1 });

    const missing = createOrderClient({ baseUrl: 'http://orders', token: 't', fetchImpl: async () => json(404, {}) });
    assert.equal(await missing.getOrder('o'), null);
  });
});
