export async function request(type, payload = {}) {
  const response = await chrome.runtime.sendMessage({ type, ...payload });
  if (!response?.ok) {
    const error = new Error(response?.error || 'Could not connect. Please reload this page and try again.');
    error.code = response?.code;
    error.lockedUntil = response?.lockedUntil;
    throw error;
  }
  return response;
}

export function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function formatClock(value) {
  const [hours, minutes] = value.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDays(days) {
  const ordered = [1, 2, 3, 4, 5, 6, 0].filter(day => days.includes(day));
  if (ordered.length === 7) return 'Every day';
  if (ordered.join(',') === '1,2,3,4,5') return 'Mon–Fri';
  if (ordered.join(',') === '6,0') return 'Sat–Sun';
  return ordered.map(day => ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][day]).join(', ');
}

export function scheduleDescription(rule) {
  return `${formatDays(rule.days)} · ${formatClock(rule.start)}–${formatClock(rule.end)}${rule.start > rule.end ? ' (next day)' : ''}`;
}

export function nextChange(state) {
  if (!state.settings.enabled) return 'Blocking is turned off.';
  if (!state.nextTransition) return 'No upcoming schedule changes.';
  const next = new Date(state.nextTransition);
  return `Next schedule change ${next.toLocaleString([], { weekday: 'short', hour: 'numeric', minute: '2-digit' })}`;
}

export function paintStatus(state, badge, description) {
  const active = state.settings.enabled && state.activeRules.length > 0;
  badge.textContent = !state.settings.enabled ? 'Blocking off' : active ? 'Focus time' : 'Outside focus hours';
  badge.classList.toggle('is-active', active);
  if (description) description.textContent = nextChange(state);
}

export function renderSummary(container, settings, activeRules = []) {
  container.replaceChildren();
  if (!settings.rules.length) {
    container.append(element('p', 'muted', 'No schedules yet. Add one to protect your focus time.'));
    return;
  }
  const activeIds = new Set(activeRules.map(rule => rule.id));
  for (const rule of settings.rules) {
    const item = element('div', 'schedule-summary');
    const heading = element('div', 'summary-heading');
    heading.append(element('strong', '', rule.name));
    if (!rule.enabled) heading.append(element('span', 'mini-tag', 'Off'));
    else if (activeIds.has(rule.id)) heading.append(element('span', 'mini-tag active-tag', 'Active'));
    item.append(heading, element('p', 'summary-time', scheduleDescription(rule)));
    const domains = element('div', 'domain-list');
    rule.domains.forEach(domain => domains.append(element('span', 'domain-chip', domain)));
    item.append(domains);
    container.append(item);
  }
}

export function setMessage(node, text = '', error = false) {
  node.textContent = text;
  node.classList.toggle('error-message', error);
}

export function safeOriginalUrl(hash = location.hash) {
  try {
    const url = new URL(hash.slice(1));
    return ['http:', 'https:'].includes(url.protocol) ? url : null;
  } catch {
    return null;
  }
}

export function musicIsAllowed(state) {
  const matches = domain => 'music.youtube.com' === domain || 'music.youtube.com'.endsWith(`.${domain}`);
  return !state.settings.enabled || state.settings.exceptions.some(matches) || !state.activeRules.some(rule => rule.domains.some(matches));
}
