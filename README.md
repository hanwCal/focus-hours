# Yumi Focus Hours

A small, local-only Chrome extension with scheduled website blocking, allowed website exceptions, and four-digit PIN protection for settings. No account, server, subscription, build step, or runtime dependencies.

## Install

1. Keep this folder somewhere permanent. If you downloaded the ZIP, extract it first.
2. In Chrome, open `chrome://extensions`.
3. Turn on **Developer mode** in the top-right corner.
4. Click **Load unpacked** and select the `focus-hours` folder containing `manifest.json`.
5. The settings page opens. Choose and confirm your own **four-digit PIN**. There is no default PIN.
6. Pin **Yumi Focus Hours** from Chrome’s Extensions menu if you want the toolbar shortcut.

Use Chrome 120 or later. The default schedule starts working as soon as the extension loads, even before you create a PIN. Creating a PIN protects subsequent settings changes. After editing the extension source, use its **Reload** button in `chrome://extensions`.

## Ready-to-use defaults

| Setting | Default |
| --- | --- |
| Blocked sites | `youtube.com`, `youtu.be`, `youtube-nocookie.com`, including their subdomains |
| Days | Monday–Friday |
| Time | 10:00 am inclusive to 6:00 pm exclusive |
| Always allowed | `music.youtube.com`, including its subdomains |
| Time zone | Your computer’s current local time zone |

Domains include their subdomains, and exceptions override every schedule. Blocking is limited to top-level website visits so shared media and API requests used by allowed sites remain available.

## Settings

Click the toolbar icon, then **Settings**, and enter your PIN. You can edit days and times, add separate schedules for other domains, add exceptions, or turn blocking off. Domains include all subdomains. A pasted full HTTP(S) URL is accepted and reduced to its domain; this is a domain blocker, not a page-path blocker. IP addresses, ports, and wildcard patterns are not supported in settings.

An end time earlier than the start time runs overnight, starting on each selected day. For example, Friday 10 pm–2 am ends on Saturday. Equal start/end times are rejected; use two schedules if you need full-day coverage.

Settings unlock for ten minutes in that settings page, or until you click **Lock** or restart Chrome. Opening another settings page requires the PIN again. Changing the PIN requires the current PIN. Five incorrect PIN attempts trigger a one-minute cooldown that survives browser restarts. Failed PIN attempts never change the schedule.

Existing blocked tabs are replaced with the focus screen when a schedule starts. The original URL stays in that tab’s address fragment, so **Try again** can take you back when the schedule ends. Yumi Focus Hours does not automatically reopen tabs or start playback.

## Scope and privacy

- All settings and the salted PBKDF2 PIN hash stay in this Chrome profile. The PIN is never saved in plaintext. There is no analytics, browsing-history log, or network service.
- The four-digit PIN is a friction mechanism for settings, not tamper-proof parental control. Someone controlling Chrome can disable/remove the extension, modify an unpacked extension, change the system clock, or use another browser/profile. A forgotten PIN has no hidden override; reinstalling resets the extension and its settings.
- Incognito is covered only if you enable **Allow in incognito** on the extension’s details page. The extension cannot enforce a schedule while Chrome is not running.
- Chrome can delay alarms during sleep or heavy load. The extension refreshes rules on startup, tab navigation/activation, window focus, schedule boundaries, and a 30-second maintenance alarm. A stale blocked screen after waking can be rechecked with **Try again**.
- Rules apply to top-level HTTP(S) pages, not embedded video players on other websites, installed native apps, or downloads. Chrome’s site-access setting must remain **On all sites** for all configured domains to be covered.

The `storage` permission saves settings and the PIN hash; `alarms` maintains schedules; `tabs` checks currently open URLs and replaces blocked tabs; `declarativeNetRequestWithHostAccess` and HTTP(S) host access let Chrome redirect your chosen domains to the local focus page. Host access covers arbitrary domains you may add. No page content is collected or transmitted.

## Development

```sh
cd focus-hours
npm test
npm run check
npm run package
```

Tests use Node’s built-in test runner; no `npm install` is needed for the above. Packaging creates `dist/focus-hours.zip` with only runtime files and this README. Icons, logos, and fonts are already bundled. After installing the optional development dependencies below, regenerate toolbar icons with `npm run icons`.

An optional browser smoke test uses a disposable Chrome for Testing profile and stand-in web pages; it never accesses your personal Chrome profile or YouTube account:

```sh
npm ci
npx playwright install chromium
npm run test:browser
```

This checks actual extension loading, PIN setup/change, live tab enforcement, Chrome's rule matching, domain exceptions, responsive pages, and persistence after restart. Screenshots and a report are written to `test-results/`. Set `BROWSER_EXECUTABLE` to use an existing compatible Chrome for Testing binary.

Implementation references: Chrome’s [declarative network request API](https://developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest), [alarm lifecycle](https://developer.chrome.com/docs/extensions/reference/api/alarms), and [extension storage](https://developer.chrome.com/docs/extensions/reference/api/storage).

## Yumi design assets

The UI uses the Yumi Light palette and component conventions from `yumi-core/ui/src/styles/tokens.css`, with the original Yumi head logo and toolbar icon from the existing `yumi-blur` extension. IBM Plex Sans is bundled locally in weights 400, 500, 600, and 700; its SIL Open Font License is included in `assets/fonts/OFL.txt`. There are no runtime font or logo downloads.
