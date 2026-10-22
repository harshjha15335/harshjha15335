#!/usr/bin/env node
// Checks that README.md only references local SVGs that exist, and that every
// SVG stays inside what GitHub's image sandbox will render.

import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const problems = [];

const readme = await readFile(join(ROOT, 'README.md'), 'utf8');
const srcs = [...readme.matchAll(/<img[^>]*\ssrc="([^"]+)"/g)].map((m) => m[1]);
for (const src of srcs) {
  if (/^https?:/.test(src)) problems.push(`README references remote image ${src}`);
  else if (!existsSync(join(ROOT, src))) problems.push(`README image missing: ${src}`);
}
for (const m of readme.matchAll(/<img(?![^>]*\salt=")[^>]*>/g)) problems.push(`img without alt: ${m[0].slice(0, 60)}`);
if (/<(script|iframe|style)\b/i.test(readme)) problems.push('README contains script/iframe/style');

const svgs = (await readdir(join(ROOT, 'assets'))).filter((n) => n.endsWith('.svg'));
for (const name of svgs) {
  const svg = await readFile(join(ROOT, 'assets', name), 'utf8');
  if (/<script\b|<foreignObject\b|\son\w+=/i.test(svg)) problems.push(`${name}: script, foreignObject or event handler`);
  if (/(?:href|src)="https?:/i.test(svg) || /url\(\s*['"]?https?:/i.test(svg) || /@import/i.test(svg))
    problems.push(`${name}: external resource (GitHub will not load it)`);
  if (!/<title id="title">[^<]+<\/title>/.test(svg)) problems.push(`${name}: missing <title>`);
  if (!/role="img"/.test(svg)) problems.push(`${name}: missing role="img"`);
  const ids = [...svg.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  for (const ref of svg.matchAll(/url\(#([^)]+)\)/g)) if (!ids.includes(ref[1])) problems.push(`${name}: dangling url(#${ref[1]})`);
  if (Buffer.byteLength(svg) > 1_000_000) problems.push(`${name}: larger than 1 MB`);
}

if (!srcs.length) problems.push('README has no images');
if (problems.length) {
  console.error(problems.map((p) => `✗ ${p}`).join('\n'));
  process.exit(1);
}
console.log(`✓ ${srcs.length} README images resolve; ${svgs.length} SVGs are self-contained`);
