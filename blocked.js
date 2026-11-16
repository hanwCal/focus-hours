import { request, safeOriginalUrl, nextChange, setMessage, musicIsAllowed } from './ui.js';

const $ = selector => document.querySelector(selector);
const originalUrl = safeOriginalUrl();
let refreshing = false;

async function check(continueIfAllowed = false) {
  if (refreshing) return;
  refreshing = true;
  $('#try-again').disabled = true;
  try {
    const result = originalUrl
      ? await request('CHECK_URL', { url: originalUrl.href })
      : await request('GET_STATE');
    const { state } = result;
    setMessage($('#blocked-message'));
    $('#next-change').textContent = nextChange(state);
    $('#music-link').hidden = !musicIsAllowed(state);
    if (originalUrl) {
      $('#blocked-domain').textContent = originalUrl.hostname;
      if (!result.blocked) {
        $('#blocked-title').textContent = 'You’re free to continue.';
        $('#blocked-description').textContent = 'This website is available under your current schedule.';
        $('#try-again').firstChild.textContent = 'Continue to site ';
        if (continueIfAllowed) location.replace(originalUrl.href);
      } else {
        const emphasis = document.createElement('em');
        emphasis.textContent = 'something better.';
        $('#blocked-title').replaceChildren(document.createTextNode('You made time'), document.createElement('br'), document.createTextNode('for '), emphasis);
        $('#blocked-description').textContent = 'This website is taking a break during your focus hours.';
        $('#try-again').firstChild.textContent = 'Try again ';
        if (continueIfAllowed) setMessage($('#blocked-message'), 'Still within focus hours. Your schedule is keeping this website blocked.');
      }
    } else {
      setMessage($('#blocked-message'), 'Open a website from the address bar to check access.');
      $('#try-again').hidden = true;
    }
    if (state.lastError) setMessage($('#blocked-message'), state.lastError, true);
  } catch (error) { setMessage($('#blocked-message'), error.message, true); }
  finally {
    refreshing = false;
    $('#try-again').disabled = !originalUrl;
  }
}

$('#open-settings').addEventListener('click', () => chrome.runtime.openOptionsPage());
$('#try-again').addEventListener('click', () => check(true));
document.addEventListener('visibilitychange', () => { if (!document.hidden) check(); });
setInterval(() => check(), 15000);
check();
