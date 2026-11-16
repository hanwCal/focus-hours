// Credentials stay in local extension storage; unlock sessions disappear on restart.
const PIN_KEY = 'pinCredential';
const SESSION_KEY = 'unlockSession';
const ITERATIONS = 210_000;
export const SESSION_MS = 10 * 60_000;
export const LOCKOUT_MS = 60_000;
export const MAX_ATTEMPTS = 5;

function failure(message, code, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra });
}

function validatePin(pin) {
  if (typeof pin !== 'string' || !/^\d{4}$/.test(pin)) {
    throw failure('Enter exactly four digits.', 'INVALID_PIN');
  }
}

function toHex(bytes) {
  return Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
}

async function derive(pin, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(pin), 'PBKDF2', false, ['deriveBits']);
  const saltBytes = Uint8Array.from(salt.match(/../g), byte => parseInt(byte, 16));
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations }, key, 256);
  return toHex(new Uint8Array(bits));
}

function sameHash(a, b) {
  if (a.length !== b.length) return false;
  let difference = 0;
  for (let i = 0; i < a.length; i++) difference |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return difference === 0;
}

export class PinManager {
  constructor(local, session, now = () => Date.now()) {
    this.local = local;
    this.session = session;
    this.now = now;
  }

  async info(token, owner) {
    const { [PIN_KEY]: credential } = await this.local.get(PIN_KEY);
    const { [SESSION_KEY]: session } = await this.session.get(SESSION_KEY);
    const unlocked = Boolean(credential && token && session?.token === token && session.owner === owner && session.expiresAt > this.now());
    return {
      pinConfigured: Boolean(credential),
      unlocked,
      sessionExpiresAt: unlocked ? session.expiresAt : null,
      lockedUntil: credential?.lockedUntil > this.now() ? credential.lockedUntil : 0
    };
  }

  async assertUnlocked(token, owner) {
    if (!(await this.info(token, owner)).unlocked) {
      throw failure('Your settings are locked. Enter your PIN to continue.', 'LOCKED');
    }
  }

  async newSession(owner) {
    const token = toHex(crypto.getRandomValues(new Uint8Array(32)));
    await this.session.set({ [SESSION_KEY]: { token, owner, expiresAt: this.now() + SESSION_MS } });
    return token;
  }

  async setCredential(pin) {
    const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
    const hash = await derive(pin, salt, ITERATIONS);
    await this.local.set({ [PIN_KEY]: { salt, hash, iterations: ITERATIONS, failedAttempts: 0, lockedUntil: 0 } });
  }

  async create(pin, confirmPin, owner) {
    if ((await this.local.get(PIN_KEY))[PIN_KEY]) throw failure('A PIN is already set. Unlock your settings first.', 'PIN_EXISTS');
    validatePin(pin);
    if (pin !== confirmPin) throw failure('The PINs do not match.', 'INVALID_PIN');
    await this.setCredential(pin);
    return this.newSession(owner);
  }

  async verify(pin) {
    const { [PIN_KEY]: credential } = await this.local.get(PIN_KEY);
    if (!credential) throw failure('Create your PIN first.', 'PIN_MISSING');
    if (credential.lockedUntil > this.now()) {
      throw failure('Too many attempts. Wait a minute before trying again.', 'RATE_LIMITED', { lockedUntil: credential.lockedUntil });
    }
    validatePin(pin);
    const hash = await derive(pin, credential.salt, credential.iterations);
    if (!sameHash(hash, credential.hash)) {
      const attempts = (credential.lockedUntil ? 0 : credential.failedAttempts) + 1;
      credential.failedAttempts = attempts;
      credential.lockedUntil = attempts >= MAX_ATTEMPTS ? this.now() + LOCKOUT_MS : 0;
      await this.local.set({ [PIN_KEY]: credential });
      if (credential.lockedUntil) {
        // Also invalidate any open settings window after repeated failed attempts.
        await this.session.remove(SESSION_KEY);
        throw failure('Too many attempts. Wait a minute before trying again.', 'RATE_LIMITED', { lockedUntil: credential.lockedUntil });
      }
      throw failure(`Incorrect PIN. ${MAX_ATTEMPTS - attempts} attempt${MAX_ATTEMPTS - attempts === 1 ? '' : 's'} remaining.`, 'WRONG_PIN');
    }
    await this.local.set({ [PIN_KEY]: { ...credential, failedAttempts: 0, lockedUntil: 0 } });
  }

  async unlock(pin, owner) {
    await this.verify(pin);
    return this.newSession(owner);
  }

  async change(token, currentPin, newPin, confirmPin, owner) {
    await this.assertUnlocked(token, owner);
    validatePin(newPin);
    if (newPin !== confirmPin) throw failure('The new PINs do not match.', 'INVALID_PIN');
    await this.verify(currentPin);
    await this.setCredential(newPin);
    return this.newSession(owner);
  }

  async lock(token, owner) {
    if ((await this.info(token, owner)).unlocked) await this.session.remove(SESSION_KEY);
  }
}
