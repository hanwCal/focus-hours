import { request, element, paintStatus, renderSummary, setMessage } from './ui.js';

const $ = selector => document.querySelector(selector);
let token = null;
let state = null;
let dirty = false;
let draftRevision = 0;
let refreshing = false;
let busy = false;

function updateOverview() {
  paintStatus(state, $('#status-badge'), $('#next-change'));
  $('#timezone').textContent = `Local time · ${state.timezone.replaceAll('_', ' ')}`;
  renderSummary($('#schedule-summary'), state.settings, state.activeRules);
  const exceptions = $('#exception-summary');
  exceptions.replaceChildren();
  for (const domain of state.settings.exceptions) exceptions.append(element('span', 'domain-chip', domain));
  if (!state.settings.exceptions.length) exceptions.append(element('span', 'muted', 'No exceptions'));
  if (state.lastError) setMessage($('#global-message'), state.lastError, true);
  else if ($('#global-message').classList.contains('error-message')) setMessage($('#global-message'));
}

function addRule(rule = { id: crypto.randomUUID(), name: '', enabled: true, domains: [], days: [1, 2, 3, 4, 5], start: '10:00', end: '18:00' }) {
  const card = $('#rule-template').content.firstElementChild.cloneNode(true);
  card.dataset.ruleId = rule.id;
  for (const field of ['name', 'start', 'end']) card.querySelector(`[data-field="${field}"]`).value = rule[field];
  card.querySelector('[data-field="enabled"]').checked = rule.enabled;
  card.querySelector('[data-field="domains"]').value = rule.domains.join('\n');
  const picker = card.querySelector('.day-picker');
  for (const [day, label, fullName] of [[1, 'M', 'Monday'], [2, 'T', 'Tuesday'], [3, 'W', 'Wednesday'], [4, 'T', 'Thursday'], [5, 'F', 'Friday'], [6, 'S', 'Saturday'], [0, 'S', 'Sunday']]) {
    const wrapper = element('label', 'day-option');
    const input = element('input');
    input.type = 'checkbox';
    input.value = day;
    input.checked = rule.days.includes(day);
    input.setAttribute('aria-label', fullName);
    wrapper.title = fullName;
    const visible = element('span', '', label);
    visible.setAttribute('aria-hidden', 'true');
    wrapper.append(input, visible);
    picker.append(wrapper);
  }
  card.querySelector('.remove-rule').addEventListener('click', () => {
    card.remove();
    markDirty();
  });
  $('#rules-list').append(card);
  return card;
}

function fillEditor() {
  $('#blocking-enabled').checked = state.settings.enabled;
  updateBlockingLabel();
  $('#rules-list').replaceChildren();
  state.settings.rules.forEach(addRule);
  $('#exceptions').value = state.settings.exceptions.join('\n');
  dirty = false;
  setMessage($('#settings-message'));
}

function renderAccess(previouslyUnlocked = false) {
  $('#loading-panel').hidden = true;
  const unlocked = Boolean(token && state.unlocked);
  $('#auth-panel').hidden = unlocked;
  $('#editor-panel').hidden = !unlocked;
  $('#session-panel').hidden = !unlocked;
  if (unlocked) {
    if (!previouslyUnlocked) fillEditor();
    $('#session-expiry').textContent = `Settings unlocked until ${new Date(state.sessionExpiresAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}.`;
  } else {
    token = null;
    if (previouslyUnlocked) {
      setMessage($('#auth-message'), dirty ? 'Your settings session ended. Unsaved changes were not saved. Unlock to continue.' : 'Your settings session ended. Unlock to make changes.');
      dirty = false;
      $('#settings-form').reset();
      $('#change-pin-form').reset();
    }
    const setup = !state.pinConfigured;
    $('#auth-title').textContent = setup ? 'Give your focus a PIN' : 'Unlock your settings';
    $('#auth-description').textContent = setup ? 'Choose a four-digit PIN to protect your schedule and website exceptions. Your default routine is ready below.' : 'Enter your four-digit PIN to change schedules and exceptions.';
    $('#pin-label').textContent = setup ? 'Choose a four-digit PIN' : 'Four-digit PIN';
    $('#auth-pin').autocomplete = setup ? 'new-password' : 'current-password';
    $('#confirm-pin-field').hidden = !setup;
    $('#confirm-pin').required = setup;
    $('#confirm-pin').disabled = !setup;
    $('#auth-submit').firstChild.textContent = setup ? 'Set PIN & continue ' : 'Unlock settings ';
  }
}

async function refresh() {
  if (refreshing || busy) return;
  refreshing = true;
  try {
    const previouslyUnlocked = Boolean(state?.unlocked && token);
    const result = await request('GET_STATE', { token });
    state = result.state;
    updateOverview();
    renderAccess(previouslyUnlocked);
  } catch (error) {
    setMessage($('#global-message'), error.message, true);
    $('#loading-panel').hidden = true;
  } finally { refreshing = false; }
}

function markDirty() {
  draftRevision += 1;
  dirty = true;
  setMessage($('#settings-message'), 'You have unsaved changes.');
}

function updateBlockingLabel() {
  $('#blocking-label').textContent = $('#blocking-enabled').checked ? 'Blocking on' : 'Blocking off';
}

function readSettings() {
  const splitDomains = value => value.split(/[\n,]+/).map(line => line.trim()).filter(Boolean);
  return {
    enabled: $('#blocking-enabled').checked,
    rules: [...document.querySelectorAll('.rule-card')].map(card => ({
      id: card.dataset.ruleId,
      name: card.querySelector('[data-field="name"]').value.trim(),
      enabled: card.querySelector('[data-field="enabled"]').checked,
      domains: splitDomains(card.querySelector('[data-field="domains"]').value),
      days: [...card.querySelectorAll('.day-picker input:checked')].map(input => Number(input.value)),
      start: card.querySelector('[data-field="start"]').value,
      end: card.querySelector('[data-field="end"]').value,
    })),
    exceptions: splitDomains($('#exceptions').value),
  };
}

async function perform(button, message, action) {
  if (busy) return;
  busy = true;
  button.disabled = true;
  setMessage(message);
  try { await action(); }
  catch (error) {
    setMessage(message, error.message, true);
    if (error.code === 'LOCKED') {
      token = null;
      state.unlocked = false;
      renderAccess(true);
      setMessage($('#auth-message'), error.message, true);
    }
  } finally {
    busy = false;
    button.disabled = false;
  }
}

$('#auth-form').addEventListener('submit', event => {
  event.preventDefault();
  perform($('#auth-submit'), $('#auth-message'), async () => {
    const setup = !state.pinConfigured;
    const result = await request(setup ? 'SET_PIN' : 'UNLOCK', { pin: $('#auth-pin').value, ...(setup ? { confirmPin: $('#confirm-pin').value } : {}) });
    token = result.token;
    state = result.state;
    $('#auth-form').reset();
    updateOverview();
    renderAccess(false);
    $('#blocking-enabled').focus();
  });
});

$('#add-schedule').addEventListener('click', () => {
  if ($('#rules-list').children.length >= 50) return setMessage($('#settings-message'), 'You can have up to 50 schedules.', true);
  addRule().querySelector('[data-field="name"]').focus();
  markDirty();
});
$('#settings-form').addEventListener('input', markDirty);
$('#settings-form').addEventListener('change', markDirty);
$('#blocking-enabled').addEventListener('change', updateBlockingLabel);
$('#settings-form').addEventListener('submit', event => {
  event.preventDefault();
  perform($('#save-settings'), $('#settings-message'), async () => {
    const savedRevision = draftRevision;
    const result = await request('SAVE_SETTINGS', { token, settings: readSettings() });
    state = result.state;
    const unchanged = draftRevision === savedRevision;
    if (unchanged) fillEditor();
    updateOverview();
    setMessage($('#settings-message'), unchanged ? 'Saved. Your routine is up to date.' : 'Earlier changes saved. You have unsaved changes.');
  });
});

$('#lock-settings').addEventListener('click', () => {
  perform($('#lock-settings'), $('#global-message'), async () => {
    const result = await request('LOCK', { token });
    const hadChanges = dirty;
    token = null;
    state = result.state;
    renderAccess(true);
    setMessage($('#auth-message'), hadChanges ? 'Settings locked. Unsaved changes were not saved.' : 'Settings locked. Your schedule keeps running.');
    $('#auth-pin').focus();
  });
});

$('#change-pin-form').addEventListener('submit', event => {
  event.preventDefault();
  perform(event.submitter, $('#change-pin-message'), async () => {
    const result = await request('CHANGE_PIN', { token, currentPin: $('#current-pin').value, newPin: $('#new-pin').value, confirmPin: $('#new-pin-confirm').value });
    token = result.token;
    state = result.state;
    $('#change-pin-form').reset();
    renderAccess(true);
    setMessage($('#change-pin-message'), 'Your PIN has been updated.');
  });
});

window.addEventListener('beforeunload', event => {
  if (dirty) { event.preventDefault(); event.returnValue = ''; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
setInterval(refresh, 15000);
refresh();
