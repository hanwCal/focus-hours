import { request, paintStatus, renderSummary, setMessage, musicIsAllowed } from './ui.js';

const $ = selector => document.querySelector(selector);
async function refresh() {
  try {
    const { state } = await request('GET_STATE');
    paintStatus(state, $('#status-badge'), $('#next-change'));
    $('#popup-title').textContent = state.settings.enabled && state.activeRules.length ? 'Make this time\ncount.' : 'A little space\nto focus.';
    renderSummary($('#popup-summary'), state.settings, state.activeRules);
    $('#open-settings').firstChild.textContent = state.pinConfigured ? 'Unlock settings ' : 'Set up your PIN ';
    $('#popup-footer').textContent = state.pinConfigured ? 'Your schedule works while settings are locked.' : 'Your default routine is ready. Choose a PIN to protect it.';
    $('#music-link').hidden = !musicIsAllowed(state);
    setMessage($('#popup-message'), state.lastError || '', Boolean(state.lastError));
  } catch (error) { setMessage($('#popup-message'), error.message, true); }
}

$('#open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
setInterval(refresh, 15000);
refresh();
