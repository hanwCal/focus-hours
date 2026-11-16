import { readFile, access, readdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Manifest V3 required.');
const assets = [manifest.background.service_worker, manifest.action.default_popup, manifest.options_ui.page,
  ...Object.values(manifest.icons), ...manifest.web_accessible_resources.flatMap(entry => entry.resources)];
for (const path of new Set(assets)) await access(resolve(root, path));
for (const folder of ['', 'lib']) {
  for (const file of await readdir(resolve(root, folder))) {
    if (file.endsWith('.js')) execFileSync(process.execPath, ['--check', resolve(root, folder, file)]);
    if (file.endsWith('.html')) {
      const html = await readFile(resolve(root, folder, file), 'utf8');
      for (const match of html.matchAll(/<(?:script|link|img)\b[^>]*(?:src|href)="([^"]+)"/g)) {
        if (/^https?:/.test(match[1])) throw new Error(`Remote asset in ${file}: ${match[1]}`);
        await access(resolve(root, folder, match[1]));
      }
      if (/<script(?![^>]*\bsrc=)[^>]*>/i.test(html)) throw new Error(`Inline script in ${file}`);
      if (/\son[a-z]+\s*=/i.test(html)) throw new Error(`Inline event handler in ${file}`);
    }
    if (file.endsWith('.css')) {
      const css = await readFile(resolve(root, folder, file), 'utf8');
      for (const match of css.matchAll(/url\(["']?([^\s)"']+)["']?\)/g)) {
        if (/^https?:/.test(match[1])) throw new Error(`Remote asset in ${file}: ${match[1]}`);
        if (!match[1].startsWith('data:')) await access(resolve(root, folder, match[1]));
      }
    }
  }
}
console.log('Manifest, extension assets, JavaScript syntax and CSP checks passed.');
