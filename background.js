import { DEFAULT_SETTINGS, validateSettings, getActiveRules, isUrlBlocked, nextTransition, buildDynamicRules } from './lib/schedule.js';
import { PinManager } from './lib/auth.js';

const HEARTBEAT = 'focus-hours-heartbeat';
const BOUNDARY = 'focus-hours-boundary';
const blockedPage = chrome.runtime.getURL('blocked.html');
const optionsPage = chrome.runtime.getURL('options.html');
const pin = new PinManager(chrome.storage.local, chrome.storage.session);
let pending = Promise.resolve();
let lastError = null;

function canonicalRules(rules) {
  const normalize = value => Array.isArray(value) ? value.map(normalize)
    : value && typeof value === 'object'
      ? Object.fromEntries(Object.keys(value).sort().map(key => [key, normalize(value[key])]))
      : value;
  return JSON.stringify(normalize([...rules].sort((a, b) => a.id - b.id)));
}

// Serialize alarms, settings changes and PIN attempts, including across async hashing.
function enqueue(task) {
  const result = pending.then(task);
  pending = result.catch(() => {});
  return result;
}

async function readSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  if (settings) return validateSettings(settings);
  const initial = structuredClone(DEFAULT_SETTINGS);
  await chrome.storage.local.set({ settings: initial });
  return initial;
}

async function updateAlarms(settings, now) {
  if (!(await chrome.alarms.get(HEARTBEAT))) {
    await chrome.alarms.create(HEARTBEAT, { periodInMinutes: 0.5 });
  }
  const next = nextTransition(settings, now);
  const current = await chrome.alarms.get(BOUNDARY);
  if (next) {
    if (!current || Math.abs(current.scheduledTime - next.getTime()) > 1000) {
      await chrome.alarms.create(BOUNDARY, { when: next.getTime() });
    }
  } else if (current) {
    await chrome.alarms.clear(BOUNDARY);
  }
}

async function enforceOpenTabs(settings, now) {
  const tabs = await chrome.tabs.query({});
  await Promise.all(tabs.map(async tab => {
    const url = tab.pendingUrl || tab.url;
    // DNR handles in-flight navigations. Updating a loading tab here would race
    // its redirect and repeatedly abort the local block page while it loads.
    if (tab.id == null || tab.status === 'loading' || !isUrlBlocked(url, settings, now)) return;
    try {
      // Do not replace a new allowed navigation using an older tab snapshot.
      const current = await chrome.tabs.get(tab.id);
      const currentUrl = current.pendingUrl || current.url;
      if (current.status !== 'loading' && isUrlBlocked(currentUrl, settings, new Date())) {
        await chrome.tabs.update(tab.id, { url: `${blockedPage}#${currentUrl}` });
      }
    } catch {
      // Tabs can close or begin another navigation while an alarm is being handled.
    }
  }));
}

async function reconcile() {
  const settings = await readSettings();
  const now = new Date();
  const desired = buildDynamicRules(settings, now, blockedPage);
  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  // Keep persisted rules in place while Chrome suspends the service worker.
  if (canonicalRules(existing) !== canonicalRules(desired)) {
    await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds: existing.map(rule => rule.id), addRules: desired });
  }
  await updateAlarms(settings, now);
  await enforceOpenTabs(settings, now);
  const active = getActiveRules(settings, now).length > 0;
  await chrome.action.setBadgeText({ text: active ? 'ON' : '' });
  await chrome.action.setBadgeBackgroundColor({ color: '#0f766e' });
  await chrome.action.setTitle({ title: active ? 'Yumi Focus Hours · blocking distractions' : 'Yumi Focus Hours · outside focus hours' });
  lastError = null;
  return settings;
}

async function recordError(error) {
  lastError = error?.message || 'Could not apply the blocking schedule.';
  console.error('Yumi Focus Hours:', lastError);
  await chrome.action.setBadgeText({ text: '!' }).catch(() => {});
  await chrome.action.setBadgeBackgroundColor({ color: '#b42318' }).catch(() => {});
}

function requestSync() {
  return enqueue(reconcile).catch(recordError);
}

async function publicState(token, owner) {
  const settings = await readSettings();
  const now = new Date();
  return {
    settings,
    ...await pin.info(token, owner),
    activeRules: getActiveRules(settings, now),
    now: now.toISOString(),
    nextTransition: nextTransition(settings, now)?.toISOString() || null,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    lastError
  };
}

function trustedPage(sender) {
  if (sender.id !== chrome.runtime.id || !sender.url) return false;
  try {
    const url = new URL(sender.url);
    return url.protocol === 'chrome-extension:' && url.hostname === chrome.runtime.id &&
      ['/options.html', '/popup.html', '/blocked.html'].includes(url.pathname);
  } catch { return false; }
}

async function handleMessage(message, sender) {
  if (!trustedPage(sender)) throw new Error('This request must come from Yumi Focus Hours.');
  if (!message || typeof message.type !== 'string') throw new Error('Invalid request.');
  const owner = sender.documentId || sender.url;
  const mutations = ['SET_PIN', 'UNLOCK', 'SAVE_SETTINGS', 'CHANGE_PIN', 'LOCK'];
  if (mutations.includes(message.type) && sender.url.split(/[?#]/)[0] !== optionsPage) {
    throw new Error('Open settings to make changes.');
  }
  let token = message.token;
  switch (message.type) {
    case 'GET_STATE':
    case 'CHECK_URL':
      try { await reconcile(); } catch (error) { await recordError(error); }
      break;
    case 'SET_PIN':
      token = await pin.create(message.pin, message.confirmPin, owner);
      break;
    case 'UNLOCK':
      token = await pin.unlock(message.pin, owner);
      break;
    case 'LOCK':
      await pin.lock(token, owner);
      token = null;
      break;
    case 'CHANGE_PIN':
      token = await pin.change(token, message.currentPin, message.newPin, message.confirmPin, owner);
      break;
    case 'SAVE_SETTINGS': {
      await pin.assertUnlocked(token, owner);
      const settings = validateSettings(message.settings);
      const previous = await readSettings();
      await chrome.storage.local.set({ settings });
      try {
        await reconcile();
      } catch (error) {
        await chrome.storage.local.set({ settings: previous });
        try { await reconcile(); } catch (rollbackError) { await recordError(rollbackError); }
        throw new Error(`Your changes could not be applied. Previous settings were restored. ${error.message}`);
      }
      break;
    }
    default:
      throw new Error('Unknown request.');
  }
  const state = await publicState(token, owner);
  return {
    ok: true,
    ...(token && ['SET_PIN', 'UNLOCK', 'CHANGE_PIN'].includes(message.type) ? { token } : {}),
    ...(message.type === 'CHECK_URL' ? { blocked: isUrlBlocked(message.url, state.settings, new Date()) } : {}),
    state
  };
}

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  enqueue(() => handleMessage(message, sender)).then(respond, error => {
    respond({ ok: false, error: error.message || 'Something went wrong.', code: error.code, lockedUntil: error.lockedUntil });
  });
  return true;
});

chrome.runtime.onInstalled.addListener(details => {
  requestSync().then(() => {
    if (details.reason === 'install') return chrome.runtime.openOptionsPage();
  }).catch(recordError);
});
chrome.runtime.onStartup.addListener(requestSync);
chrome.alarms.onAlarm.addListener(alarm => {
  if ([HEARTBEAT, BOUNDARY].includes(alarm.name)) requestSync();
});
chrome.tabs.onUpdated.addListener((_tabId, change) => {
  if (change.url || change.status === 'loading' || change.status === 'complete') requestSync();
});
chrome.tabs.onActivated.addListener(requestSync);
chrome.windows.onFocusChanged.addListener(requestSync);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes.settings) requestSync();
});

// Event listeners are registered synchronously; initialization is queued before messages.
enqueue(async () => {
  await chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  await chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  return reconcile();
}).catch(recordError);
