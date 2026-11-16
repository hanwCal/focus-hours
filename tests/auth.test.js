import test from 'node:test';
import assert from 'node:assert/strict';
import { PinManager, SESSION_MS, LOCKOUT_MS, MAX_ATTEMPTS } from '../lib/auth.js';

function memoryStorage() {
  const data = {};
  return {
    data,
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) { Object.assign(data, structuredClone(values)); },
    async remove(key) { delete data[key]; },
  };
}

function fixture() {
  const local = memoryStorage();
  const session = memoryStorage();
  let now = 1_000_000;
  return {
    local, session,
    manager: new PinManager(local, session, () => now),
    advance(ms) { now += ms; },
    now: () => now,
  };
}

test('first-run PIN is exactly four digits, preserves leading zeroes and stores a salted hash', async () => {
  const { manager, local, session } = fixture();
  for (const pin of ['123', '12345', 'abcd', 1234, ' 1234', '１２３４']) {
    await assert.rejects(manager.create(pin, pin, 'page-a'), { code: 'INVALID_PIN' });
  }
  await assert.rejects(manager.create('0123', '0124', 'page-a'), { code: 'INVALID_PIN' });
  const token = await manager.create('0123', '0123', 'page-a');
  assert.equal((await manager.info(token, 'page-a')).unlocked, true);
  assert.equal(local.data.pinCredential.salt.length, 32);
  assert.equal(local.data.pinCredential.hash.length, 64);
  assert.ok(local.data.pinCredential.iterations >= 100_000);
  assert.equal('pin' in local.data.pinCredential, false);
  assert.equal('token' in local.data, false);
  assert.equal(session.data.unlockSession.token, token);
  await assert.rejects(manager.create('9999', '9999', 'page-a'), { code: 'PIN_EXISTS' });
  await manager.unlock('0123', 'page-a');
  const other = fixture();
  await other.manager.create('0123', '0123', 'page-a');
  assert.notEqual(local.data.pinCredential.salt, other.local.data.pinCredential.salt);
  assert.notEqual(local.data.pinCredential.hash, other.local.data.pinCredential.hash);
});

test('sessions are document-bound, expire after ten minutes, and can be manually locked', async () => {
  const { manager, advance } = fixture();
  const token = await manager.create('2468', '2468', 'page-a');
  assert.equal((await manager.info(token, 'page-b')).unlocked, false);
  await assert.rejects(manager.assertUnlocked(token, 'page-b'), { code: 'LOCKED' });
  advance(SESSION_MS - 1);
  await manager.assertUnlocked(token, 'page-a');
  advance(1);
  await assert.rejects(manager.assertUnlocked(token, 'page-a'), { code: 'LOCKED' });
  const next = await manager.unlock('2468', 'page-a');
  await manager.lock(next, 'page-b');
  await manager.assertUnlocked(next, 'page-a');
  await manager.lock(next, 'page-a');
  await assert.rejects(manager.assertUnlocked(next, 'page-a'), { code: 'LOCKED' });
});

test('failed attempts and lockout survive worker/browser restarts, then recover', async () => {
  const fixtureData = fixture();
  const { manager, local, advance, now } = fixtureData;
  await manager.create('2468', '2468', 'page-a');
  for (let i = 1; i < MAX_ATTEMPTS; i++) {
    await assert.rejects(manager.unlock('0000', 'page-a'), { code: 'WRONG_PIN' });
  }
  // A new manager and empty session area simulate a browser restart.
  const restarted = new PinManager(local, memoryStorage(), now);
  await assert.rejects(restarted.unlock('0000', 'page-b'), { code: 'RATE_LIMITED' });
  assert.equal((await restarted.info(null, 'page-b')).lockedUntil, now() + LOCKOUT_MS);
  await assert.rejects(restarted.unlock('2468', 'page-b'), { code: 'RATE_LIMITED' });
  advance(LOCKOUT_MS);
  const token = await restarted.unlock('2468', 'page-b');
  assert.equal((await restarted.info(token, 'page-b')).unlocked, true);
  assert.equal(local.data.pinCredential.failedAttempts, 0);
  assert.equal(local.data.pinCredential.lockedUntil, 0);
});

test('changing PIN requires an unlocked session and current PIN, rotates credentials and sessions', async () => {
  const { manager, local } = fixture();
  const original = await manager.create('2468', '2468', 'page-a');
  const oldSalt = local.data.pinCredential.salt;
  await assert.rejects(manager.change('made-up', '2468', '1357', '1357', 'page-a'), { code: 'LOCKED' });
  await assert.rejects(manager.change(original, '9999', '1357', '1357', 'page-a'), { code: 'WRONG_PIN' });
  await assert.rejects(manager.change(original, '2468', '1357', '1358', 'page-a'), { code: 'INVALID_PIN' });
  const next = await manager.change(original, '2468', '1357', '1357', 'page-a');
  assert.notEqual(local.data.pinCredential.salt, oldSalt);
  assert.notEqual(next, original);
  await assert.rejects(manager.assertUnlocked(original, 'page-a'), { code: 'LOCKED' });
  await manager.assertUnlocked(next, 'page-a');
  await assert.rejects(manager.unlock('2468', 'page-a'), { code: 'WRONG_PIN' });
  await manager.unlock('1357', 'page-a');
});
