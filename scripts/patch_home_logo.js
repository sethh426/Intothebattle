import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const homePath = path.join(projectRoot, 'home.html');

if (!fs.existsSync(homePath)) {
  console.warn('[patch-home-logo] home.html not found; skipping logo patch.');
  process.exit(0);
}

const original = fs.readFileSync(homePath, 'utf8');
let updated = original.replace(
  '<span class="brand-mark"><span>⚔️</span></span>',
  '<span class="brand-mark"><img src="/logo.svg" alt="IntoTheBattle logo" style="width:100%;height:100%;display:block;object-fit:contain;" /></span>'
);

if (updated !== original) {
  fs.writeFileSync(homePath, updated, 'utf8');
  console.log('[patch-home-logo] Replaced home page header emoji with /logo.svg.');
} else {
  console.log('[patch-home-logo] Home page logo already patched or pattern not found.');
}
