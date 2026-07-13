import { readFileSync, writeFileSync } from 'node:fs';

const wsBase = process.argv[2];

if (!wsBase) {
  console.error('WS_BASE value is required');
  process.exit(1);
}

const indexPath = new URL('../client/index.html', import.meta.url);
const assignmentPattern = /window\.__WS_BASE__\s*=\s*["'][^"']*["']\s*;/g;

const html = readFileSync(indexPath, 'utf8');
const serializedWsBase = JSON.stringify(wsBase).replace(/</g, '\\u003c');
let replacements = 0;

const nextHtml = html.replace(assignmentPattern, () => {
  replacements += 1;
  return `window.__WS_BASE__ = ${serializedWsBase};`;
});

if (replacements === 0) {
  console.error('Could not find window.__WS_BASE__ assignment in client/index.html');
  process.exit(1);
}

if (/window\.__WS_BASE__\s*=\s*[^;]*localhost[^;]*;/i.test(nextHtml)) {
  console.error('Injected window.__WS_BASE__ assignment still contains localhost');
  process.exit(1);
}

writeFileSync(indexPath, nextHtml);
