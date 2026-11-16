import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_SETTINGS } from '../lib/schedule.js';

function event() {
  const listeners = [];
  return { addListener(fn) { listeners.push(fn); }, emit(...args) { for (const fn of listeners) fn(...args); }, listeners };
}

function reordered(value) {
  if (Array.isArray(value)) return value.map(reordered);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reordered(item)]));
  return value;
}

function storageArea(onChanged, area) {
  const data = {};
  return {
    data,
    async get(key) { return structuredClone({ [key]: data[key] }); },
    async set(values) {
      const changes = {};
      for (const [key, value] of Object.entries(values)) changes[key] = { oldValue: data[key], newValue: structuredClone(value) };
      Object.assign(data, structuredClone(values));
      onChanged.emit(changes, area);
    },
    async remove(key) { delete data[key]; },
    async setAccessLevel() {},
  };
}

async function setup() {
  const onChanged = event();
  const alarms = new Map();
  const tabData = new Map();
  let rules = [];
  const model = { rulesUpdates: 0, failNextRuleUpdate: false, reorderRules: false, optionsOpened: 0, tabData, alarms };
  const id = 'abcdefghijklmnopabcdefghijklmnop';
  globalThis.chrome = {
    runtime: {
      id, getURL: path => `chrome-extension://${id}/${path}`,
      onMessage: event(), onInstalled: event(), onStartup: event(),
      async openOptionsPage() { model.optionsOpened++; },
    },
    storage: { local: storageArea(onChanged, 'local'), session: storageArea(onChanged, 'session'), onChanged },
    alarms: {
      onAlarm: event(),
      async get(name) { return alarms.get(name); },
      async create(name, options) { alarms.set(name, { name, scheduledTime: options.when || Date.now() + options.periodInMinutes * 60_000, ...options }); },
      async clear(name) { return alarms.delete(name); },
    },
    tabs: {
      onUpdated: event(), onActivated: event(),
      async query() { return structuredClone([...tabData.values()]); },
      async get(id) {
        model.beforeTabRead?.(id);
        if (!tabData.has(id)) throw new Error('Tab closed');
        return structuredClone(tabData.get(id));
      },
      async update(id, change) { Object.assign(tabData.get(id), change); return structuredClone(tabData.get(id)); },
    },
    windows: { onFocusChanged: event() },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {} },
    declarativeNetRequest: {
      async getDynamicRules() { return model.reorderRules ? reordered(rules) : structuredClone(rules); },
      async updateDynamicRules({ removeRuleIds, addRules }) {
        model.rulesUpdates++;
        if (model.failNextRuleUpdate) {
          model.failNextRuleUpdate = false;
          throw new Error('Simulated Chrome rule rejection');
        }
        rules = [...rules.filter(rule => !removeRuleIds.includes(rule.id)), ...structuredClone(addRules)];
      },
    },
  };
  const optionsSender = { id, url: chrome.runtime.getURL('options.html'), documentId: 'options-document-1' };
  const send = (message, sender = optionsSender) => new Promise(resolve => {
    const keepChannelOpen = chrome.runtime.onMessage.listeners[0](message, sender, resolve);
    assert.equal(keepChannelOpen, true);
  });
  await import(`../background.js?fixture=${crypto.randomUUID()}`);
  await send({ type: 'GET_STATE' }); // Drains initialization before assertions.
  return { ...model, model, send, optionsSender, chrome: globalThis.chrome, rules: () => structuredClone(rules) };
}

function activeSettings() {
  // Together these cover all local minutes, independent of the test host's clock.
  return {
    enabled: true,
    exceptions: ['music.youtube.com'],
    rules: ['morning', 'evening'].map((id, index) => ({
      id, name: id, enabled: true, domains: ['youtube.com'], days: [0, 1, 2, 3, 4, 5, 6],
      start: index ? '12:00' : '00:00', end: index ? '00:00' : '12:00',
    })),
  };
}

test('background enforces settings authorization and rejects webpage or non-options mutations', async () => {
  const { send, optionsSender, chrome } = await setup();
  const settings = { ...structuredClone(DEFAULT_SETTINGS), enabled: false };
  const locked = await send({ type: 'SAVE_SETTINGS', settings, token: 'guessed-token' });
  assert.equal(locked.ok, false);
  assert.equal(locked.code, 'LOCKED');
  assert.equal(chrome.storage.local.data.settings.enabled, true);
  for (const sender of [
    { ...optionsSender, id: 'another-extension' },
    { ...optionsSender, url: 'https://youtube.com/' },
    { ...optionsSender, url: chrome.runtime.getURL('other.html') },
  ]) {
    assert.equal((await send({ type: 'GET_STATE' }, sender)).ok, false);
  }
  for (const file of ['blocked.html', 'popup.html']) {
    const sender = { ...optionsSender, url: chrome.runtime.getURL(file) };
    assert.equal((await send({ type: 'GET_STATE' }, sender)).ok, true);
    assert.equal((await send({ type: 'SET_PIN', pin: '1234', confirmPin: '1234' }, sender)).ok, false);
  }
  const setupPin = await send({ type: 'SET_PIN', pin: '0123', confirmPin: '0123' });
  assert.equal(setupPin.ok, true);
  const deniedOtherDocument = await send({ type: 'SAVE_SETTINGS', token: setupPin.token, settings }, { ...optionsSender, documentId: 'options-document-2' });
  assert.equal(deniedOtherDocument.code, 'LOCKED');
  const saved = await send({ type: 'SAVE_SETTINGS', token: setupPin.token, settings });
  assert.equal(saved.ok, true);
  assert.equal(saved.state.settings.enabled, false);
  await send({ type: 'LOCK', token: setupPin.token });
  assert.equal((await send({ type: 'SAVE_SETTINGS', token: setupPin.token, settings })).code, 'LOCKED');
});

test('saving an active schedule redirects open YouTube tabs and preserves YouTube Music', async () => {
  const { send, tabData, rules, chrome } = await setup();
  const { token } = await send({ type: 'SET_PIN', pin: '2468', confirmPin: '2468' });
  const original = 'https://www.youtube.com/watch?v=example#t=60';
  tabData.set(1, { id: 1, url: original });
  tabData.set(2, { id: 2, url: 'https://music.youtube.com/watch?v=music' });
  tabData.set(3, { id: 3, url: 'https://notyoutube.com/' });
  const saved = await send({ type: 'SAVE_SETTINGS', token, settings: activeSettings() });
  assert.equal(saved.ok, true);
  assert.equal(tabData.get(1).url, `${chrome.runtime.getURL('blocked.html')}#${original}`);
  assert.equal(tabData.get(2).url, 'https://music.youtube.com/watch?v=music');
  assert.equal(tabData.get(3).url, 'https://notyoutube.com/');
  const allow = rules().find(rule => rule.action.type === 'allow');
  const redirect = rules().find(rule => rule.action.type === 'redirect');
  assert.ok(allow.priority > redirect.priority);
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  assert.equal((await send({ type: 'CHECK_URL', url: original })).blocked, true);
  assert.equal((await send({ type: 'CHECK_URL', url: 'https://music.youtube.com/' })).blocked, false);
  const disabled = { ...activeSettings(), enabled: false };
  assert.equal((await send({ type: 'SAVE_SETTINGS', token, settings: disabled })).ok, true);
  assert.deepEqual(rules(), []);
});

test('failed Chrome rule updates restore previous settings and blocking rules', async () => {
  const { send, chrome, model, rules } = await setup();
  const { token } = await send({ type: 'SET_PIN', pin: '2468', confirmPin: '2468' });
  await send({ type: 'SAVE_SETTINGS', token, settings: activeSettings() });
  const previous = structuredClone(chrome.storage.local.data.settings);
  const previousRules = rules();
  model.failNextRuleUpdate = true;
  const result = await send({ type: 'SAVE_SETTINGS', token, settings: { ...activeSettings(), enabled: false } });
  assert.equal(result.ok, false);
  assert.match(result.error, /Previous settings were restored/);
  assert.deepEqual(chrome.storage.local.data.settings, previous);
  assert.deepEqual(rules(), previousRules);
});

test('an alarm snapshot cannot replace a newer navigation to an allowed site', async () => {
  const { send, model, tabData } = await setup();
  const { token } = await send({ type: 'SET_PIN', pin: '2468', confirmPin: '2468' });
  tabData.set(7, { id: 7, url: 'https://www.youtube.com/' });
  model.beforeTabRead = id => {
    tabData.get(id).pendingUrl = 'https://music.youtube.com/';
  };
  assert.equal((await send({ type: 'SAVE_SETTINGS', token, settings: activeSettings() })).ok, true);
  assert.equal(tabData.get(7).url, 'https://www.youtube.com/');
  assert.equal(tabData.get(7).pendingUrl, 'https://music.youtube.com/');
});

test('startup reconstructs missing alarms and concurrent PIN guesses cannot bypass lockout', async () => {
  const { send, chrome, alarms } = await setup();
  const { token } = await send({ type: 'SET_PIN', pin: '2468', confirmPin: '2468' });
  await send({ type: 'SAVE_SETTINGS', token, settings: activeSettings() });
  alarms.clear();
  chrome.runtime.onStartup.emit();
  await send({ type: 'GET_STATE' });
  assert.equal(alarms.get('focus-hours-heartbeat').periodInMinutes, 0.5);
  assert.ok(alarms.get('focus-hours-boundary').scheduledTime > Date.now());
  const results = await Promise.all(Array.from({ length: 6 }, () => send({ type: 'UNLOCK', pin: '0000' })));
  assert.equal(results.filter(result => result.code === 'WRONG_PIN').length, 4);
  assert.equal(results.filter(result => result.code === 'RATE_LIMITED').length, 2);
  assert.equal((await send({ type: 'SAVE_SETTINGS', token, settings: activeSettings() })).code, 'LOCKED');
});

test('equivalent Chrome rule objects do not trigger redundant rule replacement', async () => {
  const { send, model } = await setup();
  const { token } = await send({ type: 'SET_PIN', pin: '2468', confirmPin: '2468' });
  await send({ type: 'SAVE_SETTINGS', token, settings: activeSettings() });
  await send({ type: 'GET_STATE' });
  model.reorderRules = true;
  const before = model.rulesUpdates;
  await send({ type: 'GET_STATE' });
  await send({ type: 'GET_STATE' });
  assert.equal(model.rulesUpdates, before);
});
