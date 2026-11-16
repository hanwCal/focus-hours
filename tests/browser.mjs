// Optional full-browser smoke test. Uses a disposable profile, never your Chrome data.
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_SETTINGS } from '../lib/schedule.js';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const output = resolve(root, 'test-results');
await mkdir(output, { recursive: true });
const profile = await mkdtemp(join(tmpdir(), 'focus-hours-browser-'));
const errors = [];
const checks = [];
let context;
try {
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
    viewport: { width: 1280, height: 1000 },
  });
  context.on('page', page => page.on('pageerror', error => errors.push(error.message)));
  // Stand-in pages keep the test deterministic and avoid accessing real accounts.
  await context.route(/^https?:\/\//, route => route.fulfill({
    contentType: 'text/html', body: '<!doctype html><title>Allowed test website</title><h1>Website reached</h1>',
  }));
  const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
  // URL.origin is opaque for chrome-extension in Node; derive it directly.
  const extensionOrigin = worker.url().replace(/\/background\.js$/, '');
  const options = await context.newPage();
  await options.goto(`${extensionOrigin}/options.html`);
  await options.locator('#auth-panel').waitFor({ state: 'visible' });
  const initial = await options.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  assert.deepEqual(initial.state.settings, DEFAULT_SETTINGS);
  assert.equal(initial.state.pinConfigured, false);
  checks.push('Fresh install has the requested weekday schedule and Music exception.');
  await options.screenshot({ path: join(output, 'setup.png'), fullPage: true });

  await options.locator('#auth-pin').fill('0482');
  await options.locator('#confirm-pin').fill('0482');
  await options.locator('#auth-submit').click();
  await options.locator('#editor-panel').waitFor({ state: 'visible' });
  checks.push('First-run PIN setup unlocks the settings editor.');

  async function save() {
    await options.locator('#save-settings').click();
    await options.waitForFunction(() => document.querySelector('#settings-message').textContent.startsWith('Saved.'));
  }
  await options.locator('#blocking-enabled').uncheck();
  await save();
  const youtube = await context.newPage();
  const originalUrl = 'https://www.youtube.com/watch?v=focus-hours-test';
  await youtube.goto(originalUrl);
  assert.equal(await youtube.title(), 'Allowed test website');
  const music = await context.newPage();
  await music.goto('https://music.youtube.com/watch?v=focus-hours-test');

  await options.locator('#blocking-enabled').check();
  for (const checkbox of await options.locator('.day-picker input').all()) await checkbox.check();
  const now = new Date();
  const lastMinute = now.getHours() === 23 && now.getMinutes() === 59;
  await options.locator('[data-field="start"]').fill(lastMinute ? '00:01' : '00:00');
  await options.locator('[data-field="end"]').fill(lastMinute ? '00:00' : '23:59');
  await save();
  await youtube.waitForURL(url => url.href.startsWith(`${extensionOrigin}/blocked.html#`));
  await youtube.locator('#blocked-domain').waitFor({ state: 'visible' });
  assert.equal(music.url(), 'https://music.youtube.com/watch?v=focus-hours-test');
  assert.equal(await music.title(), 'Allowed test website');
  checks.push('Saving an active schedule replaces existing YouTube tabs and leaves Music open.');
  await youtube.screenshot({ path: join(output, 'blocked.png'), fullPage: true });

  const outcomes = await worker.evaluate(async () => {
    const result = {};
    for (const [name, request] of Object.entries({
      youtube: { url: 'https://www.youtube.com/watch?v=x', type: 'main_frame' },
      short: { url: 'https://youtu.be/x', type: 'main_frame' },
      mobile: { url: 'https://m.youtube.com/', type: 'main_frame' },
      trailingDot: { url: 'https://youtube.com./', type: 'main_frame' },
      music: { url: 'https://music.youtube.com/', type: 'main_frame' },
      musicTrailingDot: { url: 'https://music.youtube.com./', type: 'main_frame' },
      lookalike: { url: 'https://youtube.com.example.org/', type: 'main_frame' },
      mediaApi: { url: 'https://www.youtube.com/youtubei/v1/player', type: 'xmlhttprequest', initiator: 'https://music.youtube.com' },
    })) {
      result[name] = (await chrome.declarativeNetRequest.testMatchOutcome(request)).matchedRules.map(match => match.ruleId);
    }
    return result;
  });
  await writeFile(join(output, 'rule-outcomes.json'), JSON.stringify(outcomes, null, 2));
  for (const key of ['youtube', 'short', 'mobile', 'trailingDot']) assert.ok(outcomes[key].includes(2), `${key}: DNR must block`);
  for (const key of ['music', 'musicTrailingDot']) assert.deepEqual(outcomes[key], [1], `${key}: exception must win`);
  for (const key of ['lookalike', 'mediaApi']) assert.deepEqual(outcomes[key], [], `${key}: must remain allowed`);
  checks.push('Chrome DNR matches blocked domains, trailing dots and Music exceptions without blocking Music API requests.');

  const navigation = await context.newPage();
  await navigation.goto('https://youtu.be/short-link-test').catch(error => {
    if (!error.message.includes('ERR_ABORTED')) throw error;
  });
  await navigation.waitForURL(url => url.href.startsWith(`${extensionOrigin}/blocked.html#`), { waitUntil: 'commit' });
  await navigation.locator('#blocked-domain').waitFor({ state: 'visible' });
  assert.equal(new URL(navigation.url()).hash.slice(1), 'https://youtu.be/short-link-test');
  checks.push('Actual short-link navigation is redirected and retains its original URL.');

  const unauthorized = await options.evaluate(settings => chrome.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings }), { ...DEFAULT_SETTINGS, enabled: false });
  assert.equal(unauthorized.code, 'LOCKED');
  await options.locator('#lock-settings').click();
  await options.locator('#auth-panel').waitFor({ state: 'visible' });
  await options.locator('#auth-pin').fill('1111');
  await options.locator('#auth-submit').click();
  await options.waitForFunction(() => document.querySelector('#auth-message').textContent.includes('Incorrect PIN'));
  assert.equal(await options.locator('#editor-panel').isVisible(), false);
  await options.locator('#auth-pin').fill('0482');
  await options.locator('#auth-submit').click();
  await options.locator('#editor-panel').waitFor({ state: 'visible' });
  checks.push('Missing and incorrect PINs cannot edit settings; the correct PIN unlocks.');

  await options.locator('summary').click();
  await options.locator('#current-pin').fill('0482');
  await options.locator('#new-pin').fill('2740');
  await options.locator('#new-pin-confirm').fill('2740');
  await options.getByRole('button', { name: 'Update PIN' }).click();
  await options.waitForFunction(() => document.querySelector('#change-pin-message').textContent.includes('updated'));
  checks.push('Changing the PIN succeeds through the settings UI.');

  await options.locator('#blocking-enabled').uncheck();
  await save();
  await youtube.locator('#try-again').click();
  await youtube.waitForURL(originalUrl);
  assert.equal(await youtube.title(), 'Allowed test website');
  checks.push('Disabling blocking lets the focus screen return to its original page.');

  // Restore the requested settings for screenshots and persistence validation.
  await options.locator('#blocking-enabled').check();
  for (const checkbox of await options.locator('.day-picker input').all()) {
    const day = Number(await checkbox.inputValue());
    await checkbox.setChecked(day >= 1 && day <= 5);
  }
  await options.locator('[data-field="start"]').fill('10:00');
  await options.locator('[data-field="end"]').fill('18:00');
  await save();
  await options.locator('summary').click();
  await options.evaluate(() => scrollTo(0, 0));
  await options.screenshot({ path: join(output, 'settings.png'), fullPage: true });
  await options.setViewportSize({ width: 390, height: 844 });
  assert.equal(await options.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await options.screenshot({ path: join(output, 'settings-mobile.png'), fullPage: true });
  const popup = await context.newPage();
  await popup.setViewportSize({ width: 360, height: 760 });
  await popup.goto(`${extensionOrigin}/popup.html`);
  await popup.waitForFunction(() => !document.querySelector('#status-badge').textContent.includes('Checking'));
  await popup.locator('body').screenshot({ path: join(output, 'popup.png') });
  assert.deepEqual(errors, []);
  checks.push('Options, compact layout, popup and blocked page load without script errors.');

  await context.close();
  context = await chromium.launchPersistentContext(profile, {
    headless: true,
    ...(process.env.BROWSER_EXECUTABLE ? { executablePath: process.env.BROWSER_EXECUTABLE } : { channel: 'chromium' }),
    args: [`--disable-extensions-except=${root}`, `--load-extension=${root}`],
  });
  const reopened = await context.newPage();
  await reopened.goto(`${extensionOrigin}/options.html`);
  await reopened.locator('#auth-panel').waitFor({ state: 'visible' });
  assert.equal(await reopened.locator('#auth-title').textContent(), 'Unlock your settings');
  await reopened.locator('#auth-pin').fill('2740');
  await reopened.locator('#auth-submit').click();
  await reopened.locator('#editor-panel').waitFor({ state: 'visible' });
  const persisted = await reopened.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_STATE' }));
  assert.deepEqual(persisted.state.settings, DEFAULT_SETTINGS);
  checks.push('Browser restart preserves schedules and the changed PIN but requires a fresh unlock.');
  await writeFile(join(output, 'browser-report.json'), JSON.stringify({ browser: context.browser()?.version(), checks, errors }, null, 2));
  console.log(checks.map(check => `PASS ${check}`).join('\n'));
} catch (error) {
  console.error('Completed checks:', checks);
  console.error('Page errors:', errors);
  for (const [index, page] of (context?.pages() || []).entries()) {
    if (page.url().includes('/options.html')) await page.screenshot({ path: join(output, `failure-${index}.png`), fullPage: true }).catch(() => {});
  }
  throw error;
} finally {
  await context?.close();
  await rm(profile, { recursive: true, force: true });
}
