import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_SETTINGS, normalizeDomain, validateSettings, isRuleActive,
  getActiveRules, isUrlBlocked, nextTransition, buildDynamicRules,
} from '../lib/schedule.js';

const defaults = () => structuredClone(DEFAULT_SETTINGS);
const local = (day, hour, minute = 0, second = 0) => new Date(2026, 10, day, hour, minute, second);
const withRule = patch => ({ ...defaults(), rules: [{ ...defaults().rules[0], ...patch }] });

test('default workday range is inclusive at 10:00 and exclusive at 18:00', () => {
  const rule = defaults().rules[0];
  assert.equal(isRuleActive(rule, local(16, 9, 59)), false); // Monday
  assert.equal(isRuleActive(rule, local(16, 10)), true);
  assert.equal(isRuleActive(rule, local(16, 17, 59, 59)), true);
  assert.equal(isRuleActive(rule, local(16, 18)), false);
  assert.equal(isRuleActive(rule, local(20, 12)), true); // Friday
  assert.equal(isRuleActive(rule, local(21, 12)), false); // Saturday
  assert.equal(isRuleActive(rule, local(22, 12)), false); // Sunday
});

test('overnight ranges belong to their starting day, including week rollover', () => {
  const rule = withRule({ days: [5], start: '22:00', end: '06:00' }).rules[0];
  assert.equal(isRuleActive(rule, local(20, 21, 59)), false);
  assert.equal(isRuleActive(rule, local(20, 22)), true);
  assert.equal(isRuleActive(rule, local(21, 5, 59)), true);
  assert.equal(isRuleActive(rule, local(21, 6)), false);
  assert.equal(isRuleActive(rule, local(21, 23)), false);
  assert.equal(isRuleActive({ ...rule, days: [6] }, local(22, 2)), true);
});

test('disabled schedules and master switch do not block', () => {
  const disabled = withRule({ enabled: false });
  assert.deepEqual(getActiveRules(disabled, local(16, 12)), []);
  assert.equal(isUrlBlocked('https://youtube.com', disabled, local(16, 12)), false);
  const off = { ...defaults(), enabled: false };
  assert.deepEqual(getActiveRules(off, local(16, 12)), []);
  assert.equal(nextTransition(off, local(16, 12)), null);
});

test('YouTube Music remains accessible while YouTube hosts and short links are blocked', () => {
  const settings = defaults();
  for (const host of ['youtube.com', 'www.youtube.com', 'm.youtube.com', 'youtu.be', 'youtube-nocookie.com', 'YOUTUBE.COM.']) {
    assert.equal(isUrlBlocked(`https://${host}/watch?v=abc`, settings, local(16, 12)), true, host);
  }
  for (const host of ['music.youtube.com', 'www.music.youtube.com', 'notyoutube.com', 'youtube.com.example.com', 'music.youtube.com.example.com']) {
    assert.equal(isUrlBlocked(`https://${host}/`, settings, local(16, 12)), false, host);
  }
  assert.equal(isUrlBlocked('https://notmusic.youtube.com/', settings, local(16, 12)), true);
  assert.equal(isUrlBlocked('https://youtube.com/', settings, local(16, 18)), false);
  assert.equal(isUrlBlocked('chrome-extension://example/blocked.html', settings, local(16, 12)), false);
  assert.equal(isUrlBlocked('not a URL', settings, local(16, 12)), false);
});

test('domain normalization accepts URLs and IDNs without broadening subdomain exceptions', () => {
  assert.equal(normalizeDomain(' YouTube.COM. '), 'youtube.com');
  assert.equal(normalizeDomain('https://MUSIC.YouTube.com/playlist?id=1#x'), 'music.youtube.com');
  assert.equal(normalizeDomain('bücher.de'), 'xn--bcher-kva.de');
  for (const value of ['*.youtube.com', 'youtube.com/watch', 'https://user:pass@youtube.com/',
    'youtube.com:443', 'https://youtube.com:443/', '127.0.0.1', '2130706433', '[::1]',
    'localhost', 'https://youtube.com\\@example.com/', 'youtube..com', '-bad.com', 'bad-.com',
    'file:///youtube.com', 'javascript:alert(1)', '', null]) {
    assert.throws(() => normalizeDomain(value), undefined, String(value));
  }
});

test('validation returns a clean copy with normalized, deduplicated values', () => {
  const input = defaults();
  input.rules[0].domains = ['YouTube.COM', 'https://youtube.com/path'];
  input.rules[0].days = [5, 1, 5];
  input.rules[0].name = '  Focus  ';
  input.rules[0].unexpected = 'discard';
  input.exceptions = ['MUSIC.YOUTUBE.COM', 'music.youtube.com'];
  const result = validateSettings(input);
  assert.deepEqual(result.rules[0].domains, ['youtube.com']);
  assert.deepEqual(result.rules[0].days, [1, 5]);
  assert.equal(result.rules[0].name, 'Focus');
  assert.equal(result.rules[0].unexpected, undefined);
  assert.deepEqual(result.exceptions, ['music.youtube.com']);
  assert.notEqual(result.rules[0], input.rules[0]);
  assert.equal(input.rules[0].name, '  Focus  ');
});

test('validation rejects ambiguous or malformed schedules and excessive input', () => {
  for (const patch of [{ days: [] }, { days: [7] }, { days: ['1'] }, { start: '9:00' },
    { start: '24:00' }, { end: '10:00' }, { domains: [] }, { name: '' }, { enabled: 'yes' }]) {
    assert.throws(() => validateSettings(withRule(patch)), undefined, JSON.stringify(patch));
  }
  assert.throws(() => validateSettings({ ...defaults(), enabled: 'true' }));
  assert.throws(() => validateSettings({ ...defaults(), exceptions: ['*.youtube.com'] }));
  assert.throws(() => validateSettings({ ...defaults(), rules: Array.from({ length: 51 }, (_, i) => ({ ...defaults().rules[0], id: `rule${i}` })) }));
  const duplicate = defaults();
  duplicate.rules.push({ ...duplicate.rules[0] });
  assert.throws(() => validateSettings(duplicate), /unique/);
  const excessive = defaults();
  excessive.rules[0].domains = Array.from({ length: 100 }, (_, i) => `site${i}.com`);
  excessive.rules.push({ ...defaults().rules[0], id: 'second' });
  assert.throws(() => validateSettings(excessive), /100 blocked/);
  assert.deepEqual(validateSettings({ enabled: true, rules: [], exceptions: [] }), { enabled: true, rules: [], exceptions: [] });
});

test('next transition skips weekends and respects exact minute boundaries', () => {
  assert.equal(+nextTransition(defaults(), local(16, 9, 59, 40)), +local(16, 10));
  assert.equal(+nextTransition(defaults(), local(16, 10)), +local(16, 18));
  assert.equal(+nextTransition(defaults(), local(20, 18)), +local(23, 10));
  const overnight = withRule({ days: [5], start: '22:00', end: '06:00' });
  assert.equal(+nextTransition(overnight, local(20, 23)), +local(21, 6));
  assert.equal(nextTransition(withRule({ enabled: false }), local(16, 10)), null);
});

test('next transition detects changes to overlapping schedules even if blocking stays active', () => {
  const settings = defaults();
  settings.rules.push({ ...defaults().rules[0], id: 'second', start: '12:00', end: '20:00' });
  assert.equal(+nextTransition(settings, local(16, 11)), +local(16, 12));
  assert.equal(+nextTransition(settings, local(16, 13)), +local(16, 18));
});

test('DST skipped and repeated hours are evaluated using actual local clock time', () => {
  const previous = process.env.TZ;
  process.env.TZ = 'America/Los_Angeles';
  try {
    const spring = withRule({ days: [0], start: '02:30', end: '04:00' });
    assert.equal(nextTransition(spring, new Date('2026-03-08T01:59:30-08:00')).toISOString(), '2026-03-08T10:00:00.000Z');
    const fall = withRule({ days: [0], start: '01:30', end: '02:00' });
    assert.equal(nextTransition(fall, new Date('2026-11-01T01:59:30-07:00')).toISOString(), '2026-11-01T09:00:00.000Z');
    assert.equal(nextTransition(fall, new Date('2026-11-01T01:00:00-08:00')).toISOString(), '2026-11-01T09:30:00.000Z');
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
});

test('DNR rules give exceptions priority and only intercept page navigation', () => {
  const rules = buildDynamicRules(defaults(), local(16, 12), 'chrome-extension://test/blocked.html');
  const allow = rules.find(rule => rule.action.type === 'allow');
  const redirect = rules.find(rule => rule.action.type === 'redirect');
  assert.ok(allow.priority > redirect.priority);
  assert.deepEqual(allow.condition.requestDomains, ['music.youtube.com']);
  assert.deepEqual(redirect.condition.requestDomains, ['youtu.be', 'youtube-nocookie.com', 'youtube.com']);
  assert.deepEqual(redirect.condition.resourceTypes, ['main_frame']);
  const url = 'https://youtube.com/watch?v=abc#time=10';
  const match = url.match(new RegExp(redirect.condition.regexFilter));
  assert.equal(redirect.action.redirect.regexSubstitution.replace('\\1', match[1]), `chrome-extension://test/blocked.html#${url}`);
  assert.deepEqual(buildDynamicRules(defaults(), local(16, 18), 'chrome-extension://test/blocked.html'), []);
});
