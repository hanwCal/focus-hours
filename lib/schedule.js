/** Pure scheduling and host matching. Days use JavaScript's Sunday=0 convention. */
export const DEFAULT_SETTINGS = {
  enabled: true,
  rules: [{
    id: 'workdays',
    name: 'Workday focus',
    enabled: true,
    domains: ['youtube.com', 'youtu.be', 'youtube-nocookie.com'],
    days: [1, 2, 3, 4, 5],
    start: '10:00',
    end: '18:00',
  }],
  exceptions: ['music.youtube.com'],
};

/**
 * Accept a DNS hostname or a pasted HTTP(S) URL. URL paths are discarded;
 * paths on bare hosts, credentials, explicit ports, IPs and wildcards are not.
 * The result is lowercase ASCII (including punycode for international names).
 */
export function normalizeDomain(input) {
  if (typeof input !== 'string' || !input.trim()) {
    throw new Error('Enter a domain, such as youtube.com.');
  }
  const source = input.trim();
  const fullUrl = /^https?:\/\//i.test(source);
  const authority = fullUrl ? source.replace(/^https?:\/\//i, '').split(/[/?#]/, 1)[0] : source;
  if (!authority || /[\s\\@:*]/.test(authority) || (!fullUrl && /[/?#]/.test(source))) {
    throw new Error('Use a domain or full https:// URL, without wildcards, credentials or ports.');
  }
  let url;
  try {
    url = new URL(fullUrl ? source : `https://${source}`);
  } catch {
    throw new Error(`“${source}” is not a valid domain.`);
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
    throw new Error('Use an http:// or https:// website without credentials or ports.');
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  const labels = host.split('.');
  if (host.length > 253 || labels.length < 2 || /^\d+(?:\.\d+)*$/.test(host)
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))) {
    throw new Error('Enter a complete domain, such as youtube.com. IP addresses are not supported.');
  }
  return host;
}

function domainList(value, label, allowEmpty = false) {
  if (!Array.isArray(value) || value.length > 100) {
    throw new Error(`${label} must contain at most 100 domains.`);
  }
  const result = [...new Set(value.map(normalizeDomain))];
  if (!allowEmpty && !result.length) throw new Error(`${label} needs at least one domain.`);
  return result;
}

function validTime(value) {
  return typeof value === 'string' && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

/** Validate untrusted messages and return a fresh, normalized settings object. */
export function validateSettings(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || typeof value.enabled !== 'boolean' || !Array.isArray(value.rules)
    || value.rules.length > 50) {
    throw new Error('Settings must include an on/off value and no more than 50 schedules.');
  }
  const ids = new Set();
  let domainCount = 0;
  const rules = value.rules.map((rule, index) => {
    const label = `Schedule ${index + 1}`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)
      || typeof rule.id !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(rule.id)
      || ids.has(rule.id)) {
      throw new Error(`${label} needs a unique schedule ID.`);
    }
    ids.add(rule.id);
    if (typeof rule.name !== 'string' || !rule.name.trim() || rule.name.trim().length > 100) {
      throw new Error(`${label} needs a name of 1–100 characters.`);
    }
    if (typeof rule.enabled !== 'boolean') throw new Error(`${label} needs an on/off value.`);
    if (!Array.isArray(rule.days) || !rule.days.length || rule.days.length > 7
      || rule.days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) {
      throw new Error(`${label}: choose at least one day of the week.`);
    }
    if (!validTime(rule.start) || !validTime(rule.end)) {
      throw new Error(`${label}: use valid start and end times.`);
    }
    if (rule.start === rule.end) {
      throw new Error(`${label}: start and end times must differ. An earlier end time runs overnight.`);
    }
    const domains = domainList(rule.domains, `${label}'s blocked sites`);
    domainCount += domains.length;
    if (domainCount > 100) throw new Error('Use no more than 100 blocked domains across all schedules.');
    return {
      id: rule.id,
      name: rule.name.trim(),
      enabled: rule.enabled,
      domains,
      days: [...new Set(rule.days)].sort((a, b) => a - b),
      start: rule.start,
      end: rule.end,
    };
  });
  return {
    enabled: value.enabled,
    rules,
    exceptions: domainList(value.exceptions, 'Exceptions', true),
  };
}

function minutes(time) {
  const [hours, mins] = time.split(':').map(Number);
  return hours * 60 + mins;
}

function activeAt(rule, day, minute) {
  if (!rule.enabled) return false;
  const start = minutes(rule.start);
  const end = minutes(rule.end);
  if (start < end) return rule.days.includes(day) && minute >= start && minute < end;
  if (start > end) {
    return (rule.days.includes(day) && minute >= start)
      || (rule.days.includes((day + 6) % 7) && minute < end);
  }
  return false;
}

/** Start inclusive, end exclusive; an overnight range belongs to its starting day. */
export function isRuleActive(rule, date = new Date()) {
  return activeAt(rule, date.getDay(), date.getHours() * 60 + date.getMinutes());
}

export function getActiveRules(settings, date = new Date()) {
  return settings.enabled ? settings.rules.filter(rule => isRuleActive(rule, date)) : [];
}

function matchesHost(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

export function isUrlBlocked(url, settings, date = new Date()) {
  let parsed;
  try { parsed = new URL(url); } catch { return false; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return false;
  const host = parsed.hostname.toLowerCase().replace(/\.$/, '');
  if (settings.exceptions.some(domain => matchesHost(host, domain))) return false;
  return getActiveRules(settings, date).some(rule => rule.domains.some(domain => matchesHost(host, domain)));
}

/**
 * Find the next change in the set of active schedules. Checking real minute
 * boundaries also handles skipped and repeated wall-clock times at DST changes.
 * Eight elapsed days cover a full local week plus timezone offset transitions.
 */
export function nextTransition(settings, date = new Date()) {
  if (!settings.enabled) return null;
  const rules = settings.rules.filter(rule => rule.enabled);
  if (!rules.length || !Number.isFinite(date.getTime())) return null;
  const compiled = rules.map(rule => ({
    days: new Set(rule.days), start: minutes(rule.start), end: minutes(rule.end),
  }));
  const active = (rule, day, minute) => rule.start < rule.end
    ? rule.days.has(day) && minute >= rule.start && minute < rule.end
    : (rule.days.has(day) && minute >= rule.start) || (rule.days.has((day + 6) % 7) && minute < rule.end);
  const initial = compiled.map(rule => active(rule, date.getDay(), date.getHours() * 60 + date.getMinutes()));
  const candidate = new Date(date);
  const first = Math.floor(date.getTime() / 60_000) * 60_000 + 60_000;
  const limit = date.getTime() + 8 * 24 * 60 * 60_000;
  for (let time = first; time <= limit; time += 60_000) {
    candidate.setTime(time);
    const day = candidate.getDay();
    const minute = candidate.getHours() * 60 + candidate.getMinutes();
    if (compiled.some((rule, index) => active(rule, day, minute) !== initial[index])) {
      return new Date(time);
    }
  }
  return null;
}

/** Main-frame blocking leaves shared APIs and media used by allowed sites alone. */
export function buildDynamicRules(settings, date = new Date(), blockedPageUrl) {
  const domains = [...new Set(getActiveRules(settings, date).flatMap(rule => rule.domains))].sort();
  if (!domains.length) return [];
  const rules = [];
  if (settings.exceptions.length) {
    rules.push({
      id: 1, priority: 2, action: { type: 'allow' },
      condition: { requestDomains: [...settings.exceptions].sort(), resourceTypes: ['main_frame'] },
    });
  }
  rules.push({
    id: 2,
    priority: 1,
    action: { type: 'redirect', redirect: { regexSubstitution: `${blockedPageUrl}#\\1` } },
    condition: { regexFilter: '^(https?://.*)$', requestDomains: domains, resourceTypes: ['main_frame'] },
  });
  return rules;
}
