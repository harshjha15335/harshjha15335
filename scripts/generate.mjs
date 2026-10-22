#!/usr/bin/env node
// Builds every SVG panel used by README.md from live, public GitHub data.
//
// Data sources (nothing is hardcoded):
//   - REST  /users/:user, /users/:user/repos, /repos/:owner/:repo/languages
//   - Contribution calendar: GraphQL when GITHUB_TOKEN is set (GitHub Actions),
//     otherwise the public https://github.com/users/:user/contributions page.
//
// Output: assets/*.svg and data/profile.json. No dependencies; Node 20+.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const USER = process.env.PROFILE_USER || 'harshjha15335';
const TOKEN = process.env.GITHUB_TOKEN || '';

// Featured projects. Copy is written from each repository's own README and
// must be re-checked whenever those projects change direction.
const PROJECTS = [
  {
    repo: 'Portfolio',
    title: 'Portfolio',
    file: 'card-portfolio.svg',
    lines: ['A walkable, golden-hour Mumbai:', 'nine districts, live project demos.'],
  },
  {
    repo: 'RepoLens',
    title: 'RepoLens',
    file: 'card-repolens.svg',
    lines: ['AST-aware hybrid RAG for codebases:', 'FAISS + BM25 + RRF, cited answers.'],
  },
  {
    repo: 'SENTINEL-',
    title: 'SENTINEL',
    file: 'card-sentinel.svg',
    lines: ['AI payment trust for PayPal merchants:', 'SHAP risk scores, human approvals.'],
  },
  {
    repo: 'NORTHSTAR',
    title: 'NORTHSTAR',
    file: 'card-northstar.svg',
    lines: ['Paper-first NSE research terminal:', 'LLM proposals behind a risk engine.'],
  },
];

const TAGLINE = 'GSoC 2026 @ Theochem  ·  Full-stack & AI engineering';

const LANG_COLORS = {
  Python: '#3572A5', TypeScript: '#3178c6', JavaScript: '#f1e05a', HTML: '#e34c26',
  CSS: '#663399', Shell: '#89e051', Dockerfile: '#384d54', Java: '#b07219', C: '#555555',
  'C++': '#f34b7d', Makefile: '#427819', Batchfile: '#C1F12E', Mako: '#7e858d',
};
const LANG_ABBR = { Python: 'PY', TypeScript: 'TS', JavaScript: 'JS', HTML: 'HTML', CSS: 'CSS' };

const SANS = `'Segoe UI', ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, 'SF Mono', Menlo, Consolas, 'Liberation Mono', monospace`;

// ---------------------------------------------------------------- fetching

async function api(path) {
  const res = await fetch(`https://api.github.com${path}`, {
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': `${USER}-profile-readme`,
      ...(TOKEN ? { Authorization: `Bearer ${TOKEN}` } : {}),
    },
  });
  if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
  return res.json();
}

const LEVELS = { NONE: 0, FIRST_QUARTILE: 1, SECOND_QUARTILE: 2, THIRD_QUARTILE: 3, FOURTH_QUARTILE: 4 };

async function calendarFromGraphQL() {
  const query = `query($login:String!){user(login:$login){contributionsCollection{contributionCalendar{
    totalContributions weeks{contributionDays{date contributionCount contributionLevel}}}}}}`;
  const res = await fetch('https://api.github.com/graphql', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'User-Agent': `${USER}-profile-readme` },
    body: JSON.stringify({ query, variables: { login: USER } }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL: ${JSON.stringify(body.errors || res.status)}`);
  const cal = body.data.user.contributionsCollection.contributionCalendar;
  return {
    total: cal.totalContributions,
    source: 'graphql',
    weeks: cal.weeks.map((w) =>
      w.contributionDays.map((d) => ({ date: d.date, count: d.contributionCount, level: LEVELS[d.contributionLevel] ?? 0 })),
    ),
  };
}

async function calendarFromPublicPage() {
  const res = await fetch(`https://github.com/users/${USER}/contributions`, {
    headers: { 'User-Agent': `${USER}-profile-readme` },
  });
  if (!res.ok) throw new Error(`contributions page -> ${res.status}`);
  const html = await res.text();
  const counts = new Map();
  for (const m of html.matchAll(/<tool-tip[^>]*for="([^"]+)"[^>]*>([^<]*)<\/tool-tip>/g)) {
    const n = m[2].match(/^(\d+) contribution/);
    counts.set(m[1], n ? Number(n[1]) : 0);
  }
  const days = [];
  for (const m of html.matchAll(/<td[^>]*ContributionCalendar-day[^>]*>/g)) {
    const tag = m[0];
    const date = tag.match(/data-date="([^"]+)"/)?.[1];
    const id = tag.match(/id="([^"]+)"/)?.[1];
    const level = Number(tag.match(/data-level="(\d)"/)?.[1] ?? 0);
    if (date) days.push({ date, level, count: counts.get(id) ?? 0 });
  }
  if (!days.length) throw new Error('no calendar cells found on public contributions page');
  days.sort((a, b) => a.date.localeCompare(b.date));
  const weeks = [];
  for (const d of days) {
    if (!weeks.length || new Date(`${d.date}T00:00:00Z`).getUTCDay() === 0) weeks.push([]);
    weeks.at(-1).push(d);
  }
  const total = Number(html.match(/([\d,]+)\s+contributions?\s+in the last year/)?.[1].replace(/,/g, '') ??
    days.reduce((s, d) => s + d.count, 0));
  return { total, weeks, source: 'public-page' };
}

async function dataUri(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`avatar -> ${res.status}`);
  const type = res.headers.get('content-type') || 'image/png';
  return `data:${type};base64,${Buffer.from(await res.arrayBuffer()).toString('base64')}`;
}

async function collect() {
  const user = await api(`/users/${USER}`);
  const repos = (await api(`/users/${USER}/repos?per_page=100&type=owner`)).filter((r) => !r.fork);
  const languages = {};
  const perRepo = {};
  for (const r of repos) {
    const langs = await api(`/repos/${USER}/${r.name}/languages`);
    perRepo[r.name] = langs;
    for (const [k, v] of Object.entries(langs)) languages[k] = (languages[k] || 0) + v;
  }
  let calendar;
  try {
    calendar = TOKEN ? await calendarFromGraphQL() : await calendarFromPublicPage();
  } catch (err) {
    if (!TOKEN) throw err;
    console.warn(`GraphQL calendar failed (${err.message}); using public page`);
    calendar = await calendarFromPublicPage();
  }
  const projects = PROJECTS.map((p) => {
    const r = repos.find((x) => x.name === p.repo);
    if (!r) throw new Error(`featured repo ${p.repo} not found`);
    return { ...p, url: r.html_url, homepage: r.homepage || null, language: r.language,
      pushed: r.pushed_at.slice(0, 10), stars: r.stargazers_count, languages: perRepo[p.repo] };
  });
  return {
    generated: new Date().toISOString().slice(0, 10),
    user: { login: user.login, url: user.html_url, followers: user.followers, publicRepos: user.public_repos },
    stars: repos.reduce((s, r) => s + r.stargazers_count, 0),
    forks: repos.reduce((s, r) => s + r.forks_count, 0),
    topLanguages: Object.entries(languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k]) => k),
    contributions: calendar,
    projects,
    avatar: await dataUri(`${user.avatar_url}${user.avatar_url.includes('?') ? '&' : '?'}s=176`),
  };
}

// ---------------------------------------------------------------- drawing

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const f = (n) => Number(n.toFixed(2));
const pct = (n) => `${Math.min(100, Math.max(0, n)).toFixed(3)}%`;

const BASE_STYLE = `
  .sans{font-family:${SANS}} .mono{font-family:${MONO}}
  .drift{animation:drift 16s ease-in-out infinite alternate}
  .drift2{animation:drift 21s ease-in-out -7s infinite alternate-reverse}
  .breathe{animation:breathe 7s ease-in-out infinite}
  .blink{animation:blink 1.1s steps(1) infinite}
  @keyframes drift{from{transform:translate(-14px,-4px)}to{transform:translate(16px,6px)}}
  @keyframes breathe{0%,100%{opacity:.75}50%{opacity:1}}
  @keyframes blink{0%,49%{opacity:1}50%,100%{opacity:0}}
  @media (prefers-reduced-motion:reduce){.drift,.drift2,.breathe,.blink,.anim{animation:none!important}}`;

// Dark glass panel with layered ambient glows: blue top-left, green top-right,
// violet bottom, teal right edge.
function panel({ w, h, rx = 18, title, desc, body, inner = 14, style = '', defs = '', glow = 1, edge = 1 }) {
  const blob = (id, cx, cy, rxx, ryy, cls) =>
    `<ellipse class="${cls}" cx="${f(cx)}" cy="${f(cy)}" rx="${f(rxx)}" ry="${f(ryy)}" fill="url(#${id})"/>`;
  const innerRect = inner
    ? `<rect x="${inner}" y="${inner}" width="${w - inner * 2}" height="${h - inner * 2}" rx="${rx - 4}" fill="url(#glass)" stroke="#60a5fa" stroke-opacity=".32"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-labelledby="title desc">
<title id="title">${esc(title)}</title>
<desc id="desc">${esc(desc)}</desc>
<defs>
<linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#0a1120"/><stop offset="1" stop-color="#04060c"/></linearGradient>
<radialGradient id="gBlue"><stop offset="0" stop-color="#3b82f6" stop-opacity="${0.42 * glow}"/><stop offset="1" stop-color="#3b82f6" stop-opacity="0"/></radialGradient>
<radialGradient id="gGreen"><stop offset="0" stop-color="#22c55e" stop-opacity="${0.3 * glow}"/><stop offset="1" stop-color="#22c55e" stop-opacity="0"/></radialGradient>
<radialGradient id="gViolet"><stop offset="0" stop-color="#a855f7" stop-opacity="${0.42 * glow}"/><stop offset="1" stop-color="#a855f7" stop-opacity="0"/></radialGradient>
<radialGradient id="gTeal"><stop offset="0" stop-color="#2dd4bf" stop-opacity="${0.3 * glow}"/><stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/></radialGradient>
<linearGradient id="edge" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b82f6" stop-opacity=".75"/><stop offset=".45" stop-color="#22d3ee" stop-opacity=".45"/><stop offset=".72" stop-color="#a855f7" stop-opacity=".6"/><stop offset="1" stop-color="#2dd4bf" stop-opacity=".7"/></linearGradient>
<linearGradient id="glass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#93c5fd" stop-opacity=".05"/><stop offset=".55" stop-color="#93c5fd" stop-opacity=".012"/><stop offset="1" stop-color="#000" stop-opacity=".25"/></linearGradient>
<linearGradient id="floor" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#3b82f6" stop-opacity="0"/><stop offset=".35" stop-color="#6366f1" stop-opacity=".55"/><stop offset=".6" stop-color="#a855f7" stop-opacity=".85"/><stop offset=".85" stop-color="#2dd4bf" stop-opacity=".55"/><stop offset="1" stop-color="#2dd4bf" stop-opacity="0"/></linearGradient>
<clipPath id="clip"><rect width="${w}" height="${h}" rx="${rx}"/></clipPath>
${defs}
<style>${BASE_STYLE}${style}</style>
</defs>
<rect width="${w}" height="${h}" rx="${rx}" fill="url(#bg)"/>
<g clip-path="url(#clip)">
${blob('gBlue', w * 0.2, h * 0.05, Math.max(150, w * 0.26), h * 0.75, 'drift')}
${blob('gGreen', w * 0.64, h * 0.18, Math.max(150, w * 0.3), h * 0.8, 'drift2')}
${blob('gViolet', w * 0.6, h * 1.02, Math.max(130, w * 0.27), h * 0.42, 'drift')}
${blob('gTeal', w * 1.0, h * 0.8, Math.max(80, w * 0.12), h * 0.5, 'drift2')}
<rect x="${f(w * 0.08)}" y="${h - 2.5}" width="${f(w * 0.84)}" height="2.5" fill="url(#floor)" class="breathe"/>
</g>
${innerRect}
<rect x=".75" y=".75" width="${w - 1.5}" height="${h - 1.5}" rx="${rx - 0.75}" fill="none" stroke="url(#edge)" stroke-opacity="${edge}" stroke-width="1.5"/>
${body}
</svg>
`;
}

const signature = (w, h) =>
  `<text x="${w - 22}" y="${h - 4}" text-anchor="end" class="mono" font-size="8" fill="#6e7681" fill-opacity=".7">github.com/${USER}</text>`;

function hero(d) {
  const w = 880, h = 236;
  let x = 38;
  const pills = d.topLanguages.map((lang) => {
    const pw = 28 + lang.length * 7.7;
    const color = LANG_COLORS[lang] || '#60a5fa';
    const out = `<g transform="translate(${f(x)},168)"><rect width="${f(pw)}" height="26" rx="13" fill="#0b1730" fill-opacity=".75" stroke="#3b82f6" stroke-opacity=".55"/>
<circle cx="14" cy="13" r="3.2" fill="${color}"/><text x="23" y="17.4" class="mono" font-size="12" font-weight="700" fill="#d1d9e0">${esc(lang)}</text></g>`;
    x += pw + 12;
    return out;
  }).join('\n');
  const body = `
<path d="M300 44 Q 440 28 600 58" fill="none" stroke="#60a5fa" stroke-opacity=".28"/>
<circle cx="600" cy="58" r="2" fill="#93c5fd" class="breathe"/>
<circle cx="88" cy="90" r="49" fill="none" stroke="url(#ring)" stroke-width="3" filter="url(#soft)"/>
<circle cx="88" cy="90" r="45" fill="#e5e7eb"/>
<image x="43" y="45" width="90" height="90" clip-path="url(#avatarClip)" preserveAspectRatio="xMidYMid slice" href="${d.avatar}" xlink:href="${d.avatar}"/>
<text x="160" y="64" class="mono" font-size="13" letter-spacing="1.6" fill="#9fb3c8">@${esc(USER)}</text>
<text x="157" y="116" class="sans" font-size="46" font-weight="800" fill="#f0f6fc" letter-spacing="-.5">${esc(USER)}</text>
<text x="160" y="144" class="sans" font-size="15" fill="#8b949e">${esc(TAGLINE)}</text>
${pills}
${signature(w, h)}`;
  return panel({
    w, h, title: `${USER} — profile banner`,
    desc: `Avatar, handle and tagline: ${TAGLINE}. Top languages by code size: ${d.topLanguages.join(', ')}.`,
    defs: `<clipPath id="avatarClip"><circle cx="88" cy="90" r="45"/></clipPath>
<linearGradient id="ring" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#60a5fa"/><stop offset=".6" stop-color="#22d3ee"/><stop offset="1" stop-color="#a855f7"/></linearGradient>
<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="2.2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    body,
  });
}

function projectsHeader(d) {
  const w = 880, h = 66;
  const body = `
<text x="30" y="34" class="mono" font-size="13" font-weight="700" letter-spacing="2" fill="#38bdf8">PROJECTS.LIST</text>
<text x="176" y="34" class="mono" font-size="11" fill="#6e7681">~/${esc(USER)}/selected</text>
<text x="850" y="34" text-anchor="end" class="mono" font-size="11" fill="#6e7681">● ${d.projects.length} projects</text>
<line x1="24" y1="48" x2="856" y2="48" stroke="#60a5fa" stroke-opacity=".35"/>
<rect class="anim scan" x="24" y="47" width="120" height="2" rx="1" fill="url(#scanG)"/>`;
  return panel({
    w, h, rx: 14, inner: 0, glow: 0.8,
    title: 'Selected projects',
    desc: `Section header for ${d.projects.length} selected projects.`,
    defs: `<linearGradient id="scanG" x1="0" x2="1"><stop offset="0" stop-color="#22d3ee" stop-opacity="0"/><stop offset=".5" stop-color="#22d3ee"/><stop offset="1" stop-color="#22d3ee" stop-opacity="0"/></linearGradient>`,
    style: `.scan{animation:scan 6s ease-in-out infinite}@keyframes scan{0%{transform:translateX(0)}50%{transform:translateX(712px)}100%{transform:translateX(0)}}`,
    body,
  });
}

function donut(cx, cy, r, langs) {
  const total = Object.values(langs).reduce((a, b) => a + b, 0) || 1;
  const entries = Object.entries(langs).sort((a, b) => b[1] - a[1]);
  const top = entries.slice(0, 3);
  const rest = entries.slice(3).reduce((s, [, v]) => s + v, 0);
  if (rest > 0) top.push(['Other', rest]);
  const C = 2 * Math.PI * r;
  let start = 0;
  const segs = top.map(([lang, v]) => {
    const len = (v / total) * C;
    const gapped = Math.max(0.5, len - 2);
    const s = `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${LANG_COLORS[lang] || '#8b949e'}" stroke-width="8" stroke-dasharray="${f(gapped)} ${f(C - gapped)}" stroke-dashoffset="${f(-start)}" transform="rotate(-90 ${cx} ${cy})"/>`;
    start += len;
    return s;
  }).join('');
  const [lead, leadV] = entries[0] || ['—', 0];
  const share = Math.round((leadV / total) * 100);
  return `<g filter="url(#soft)">
<circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#1f2937" stroke-width="8"/>${segs}</g>
<circle class="anim orbit" cx="${cx}" cy="${cy}" r="${r + 9}" fill="none" stroke="#60a5fa" stroke-opacity=".5" stroke-width="1.2" stroke-dasharray="4 10" style="transform-origin:${cx}px ${cy}px"/>
<text x="${cx}" y="${cy + 1}" text-anchor="middle" class="sans" font-size="14" font-weight="800" fill="#f0f6fc">${share}%</text>
<text x="${cx}" y="${cy + 14}" text-anchor="middle" class="mono" font-size="8.5" fill="#8b949e">${esc(LANG_ABBR[lead] || lead)}</text>`;
}

function card(p) {
  const w = 430, h = 178;
  const color = LANG_COLORS[p.language] || '#60a5fa';
  const pillW = 26 + p.language.length * 6.6;
  const breakdown = Object.entries(p.languages).sort((a, b) => b[1] - a[1]);
  const total = breakdown.reduce((s, [, v]) => s + v, 0) || 1;
  const body = `
<line x1="0" y1="28" x2="${w}" y2="28" stroke="#60a5fa" stroke-opacity=".3"/>
<circle cx="18" cy="14.5" r="3" fill="#22d3ee" class="breathe"/>
<text x="27" y="18" class="mono" font-size="10.5" fill="#8b949e">${esc(p.repo)}</text>
<rect x="${w - 27}" y="9.5" width="10" height="10" rx="2" fill="none" stroke="#8b949e" stroke-opacity=".7"/>
<text x="18" y="63" class="mono" font-size="20" font-weight="800" fill="#f0f6fc">${esc(p.title)}<tspan class="blink" fill="#22d3ee"> _</tspan></text>
<text x="18" y="88" class="mono" font-size="12.5" fill="#8b949e">${esc(p.lines[0])}</text>
<text x="18" y="105" class="mono" font-size="12.5" fill="#8b949e">${esc(p.lines[1])}</text>
<g transform="translate(18,118)"><rect width="${f(pillW)}" height="20" rx="10" fill="${color}" fill-opacity=".16" stroke="${color}" stroke-opacity=".75"/>
<circle cx="11" cy="10" r="3" fill="${color}"/><text x="19" y="14" class="mono" font-size="10.5" font-weight="700" fill="#d1d9e0">${esc(p.language)}</text></g>
<circle cx="22" cy="160" r="2.6" fill="#3b82f6"/><circle cx="32" cy="160" r="2.6" fill="#a855f7" fill-opacity=".8"/>
<text x="44" y="163.5" class="mono" font-size="9.5" fill="#6e7681">updated ${p.pushed}</text>
${donut(w - 66, 98, 30, p.languages)}`;
  return panel({
    w, h, rx: 14, inner: 0, glow: 0.75,
    title: `${p.title} — ${p.language} project`,
    desc: `${p.lines.join(' ')} Language mix: ${breakdown.slice(0, 3).map(([k, v]) => `${k} ${Math.round((v / total) * 100)}%`).join(', ')}. Last pushed ${p.pushed}.`,
    defs: `<filter id="soft" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="1.6" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    style: `.orbit{animation:orbit 18s linear infinite}@keyframes orbit{to{transform:rotate(360deg)}}`,
    body,
  });
}

// Contribution grid with a ship that patrols underneath and fires at the
// busiest days. Pure CSS keyframes: no script, safe for GitHub's <img> sandbox.
function invaders(d) {
  const WEEKS = 44, STEP = 18, TILE = 14;
  const w = 880, h = 236;
  const weeks = d.contributions.weeks.slice(-WEEKS);
  const gx = (w - (weeks.length * STEP - (STEP - TILE))) / 2;
  const gy = 24;
  const COLORS = ['#161b22', '#0e4429', '#006d32', '#26a641', '#39d353'];
  const cells = [];
  weeks.forEach((week, col) => {
    for (const day of week) {
      const row = new Date(`${day.date}T00:00:00Z`).getUTCDay();
      cells.push({ ...day, col, row, x: gx + col * STEP, y: gy + row * STEP });
    }
  });
  const tiles = cells.map((c) =>
    `<rect x="${f(c.x)}" y="${c.y}" width="${TILE}" height="${TILE}" rx="2.5" fill="${COLORS[c.level]}"${c.level ? '' : ' stroke="#ffffff" stroke-opacity=".03"'}/>`,
  ).join('');

  const markerY = gy + 7 * STEP + 10;
  const markers = weeks.map((week, col) => week.some((x) => x.count > 0)
    ? `<rect x="${f(gx + col * STEP + 5)}" y="${markerY}" width="4" height="4" rx="1" fill="#2ea043" fill-opacity=".7"/>` : '').join('');

  const targets = cells.filter((c) => c.count > 0)
    .sort((a, b) => b.count - a.count || a.date.localeCompare(b.date))
    .slice(0, 16)
    .sort((a, b) => a.col - b.col || b.row - a.row);

  const shipTop = markerY + 18;
  const startX = targets.length ? Math.max(gx + TILE / 2, targets[0].x + TILE / 2 - 140) : gx + TILE / 2;
  const frames = [{ t: 0, x: startX }];
  const shots = [];
  let t = 0.9, cur = startX;
  frames.push({ t, x: startX });
  for (const c of targets) {
    const cx = c.x + TILE / 2;
    t += Math.max(0.3, Math.abs(cx - cur) / 240);
    frames.push({ t, x: cx });
    const fire = t + 0.04;
    const dist = shipTop - 4 - (c.y + TILE / 2);
    shots.push({ c, cx, fire, hit: fire + dist / 560, dist });
    t += 0.34;
    frames.push({ t, x: cx });
    cur = cx;
  }
  if (!targets.length) {
    t += 5;
    frames.push({ t, x: gx + weeks.length * STEP - STEP / 2 });
  }
  const fadeStart = t + 1.8, fadeEnd = fadeStart + 0.6;
  t = fadeEnd + 0.2;
  frames.push({ t, x: cur });
  t += 1.4;
  frames.push({ t, x: startX });
  const T = t;
  const P = (s) => pct((s / T) * 100);

  // Without animation (static renderers, reduced motion) the ship rests under
  // its last target and every ring shows, so the frame still reads.
  const restX = targets.length ? cur : w / 2;
  const shipKf = frames.map((fr) => `${P(fr.t)}{transform:translateX(${f(fr.x - restX)}px)}`).join('');
  const flashKf = shots.map((s) => `${P(s.fire - 0.06)}{opacity:0}${P(s.fire)}{opacity:1}${P(s.fire + 0.12)}{opacity:0}`).join('');

  let css = `
.ship{animation:ship ${f(T)}s ease-in-out infinite}
@keyframes ship{${shipKf}}
.flash{opacity:0;animation:flash ${f(T)}s linear infinite}
@keyframes flash{0%{opacity:0}${flashKf}100%{opacity:0}}
.flame{animation:flame .18s ease-in-out infinite alternate;transform-box:fill-box;transform-origin:50% 0}
@keyframes flame{from{transform:scaleY(.7);opacity:.75}to{transform:scaleY(1.15);opacity:1}}
.ring{transform-box:fill-box;transform-origin:center}
.bolt{opacity:0}
@media (prefers-reduced-motion:reduce){.ship,.flash,.flame,.bolt{animation:none!important}.ring{animation:none!important;opacity:1}}`;
  const fx = shots.map((s, i) => {
    css += `
.b${i}{animation:b${i} ${f(T)}s linear infinite}@keyframes b${i}{0%,${P(s.fire)}{opacity:0;transform:translateY(0)}${P(s.fire + 0.01)}{opacity:1;transform:translateY(0)}${P(s.hit)}{opacity:1;transform:translateY(-${f(s.dist)}px)}${P(s.hit + 0.02)},100%{opacity:0;transform:translateY(-${f(s.dist)}px)}}
.r${i}{animation:r${i} ${f(T)}s ease-out infinite}@keyframes r${i}{0%,${P(s.hit)}{opacity:0;transform:scale(.2)}${P(s.hit + 0.16)}{opacity:1;transform:scale(1.4)}${P(s.hit + 0.42)},${P(fadeStart)}{opacity:1;transform:scale(1)}${P(fadeEnd)},100%{opacity:0;transform:scale(1)}}`;
    const cy = s.c.y + TILE / 2;
    return `<rect class="anim bolt b${i}" x="${f(s.cx - 1.5)}" y="${shipTop - 13}" width="3" height="9" rx="1.5" fill="#7ee787" filter="url(#glow)"/>
<g class="anim ring r${i}" filter="url(#glow)"><circle cx="${f(s.cx)}" cy="${cy}" r="10.5" fill="#2ea043" fill-opacity=".28" stroke="#7ee787" stroke-width="1.8"/><rect x="${f(s.cx - 5.5)}" y="${cy - 5.5}" width="11" height="11" rx="2.5" fill="#56d364"/></g>`;
  }).join('\n');

  const edgeDots = [36, 88, 140, 192].map((y) =>
    `<circle cx="10" cy="${y}" r="1.4" fill="#8b949e" fill-opacity=".45"/><circle cx="${w - 10}" cy="${y + 20}" r="1.4" fill="#8b949e" fill-opacity=".45"/>`).join('');

  const ship = `<g transform="translate(${f(restX)},${shipTop})"><g class="anim ship"><g transform="scale(1.35)">
<path class="anim flame" d="M-4 21 L0 31 L4 21 Z" fill="#f97316"/>
<path d="M0 0 L10 21 L3.2 18 L0 21 L-3.2 18 L-10 21 Z" fill="url(#hull)" stroke="#bfdbfe" stroke-width=".8" stroke-linejoin="round" filter="url(#glowBlue)"/>
<path d="M0 5 L2.6 13 L-2.6 13 Z" fill="#e0f2fe"/>
<circle class="anim flash" cx="0" cy="-3" r="4" fill="#bbf7d0" filter="url(#glow)"/>
</g></g></g>`;

  return panel({
    w, h, rx: 16, inner: 0, glow: 0.22, edge: 0.35,
    title: `${USER} contribution graph`,
    desc: `${d.contributions.total} contributions in the last year. The last ${weeks.length} weeks are drawn as tiles; a ship fires at the ${targets.length} busiest days.`,
    defs: `<linearGradient id="hull" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#93c5fd"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient>
<filter id="glow" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="3" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
<filter id="glowBlue" x="-80%" y="-80%" width="260%" height="260%"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    style: css,
    body: `${edgeDots}\n${tiles}\n${markers}\n${fx}\n${ship}`,
  });
}

const MILESTONES = [5, 10, 25, 50, 100, 250, 500, 1000, 2500, 5000, 10000, 25000, 50000, 100000];

function signal(d) {
  const w = 880, h = 246;
  const stats = [
    { label: 'Stars', value: d.stars, color: '#60a5fa' },
    { label: 'Contributions', value: d.contributions.total, color: '#22d3ee' },
    { label: 'Repositories', value: d.user.publicRepos, color: '#a78bfa' },
    { label: 'Forks', value: d.forks, color: '#f0abfc' },
    { label: 'Followers', value: d.user.followers, color: '#4ade80' },
  ];
  const gap = 14, bx = 40, by = 98, bh = 104, bw = (w - bx * 2 - gap * (stats.length - 1)) / stats.length, barW = bw - 32;
  const boxes = stats.map((s, i) => {
    const goal = MILESTONES.find((m) => m > s.value) ?? s.value;
    const fill = Math.max(6, (s.value / goal) * barW);
    return `<g transform="translate(${f(bx + i * (bw + gap))},${by})">
<rect width="${f(bw)}" height="${bh}" rx="12" fill="#060a14" fill-opacity=".78" stroke="#3b82f6" stroke-opacity=".45"/>
<text x="16" y="27" class="mono" font-size="11.5" font-weight="700" fill="#c9d1d9">${s.label}</text>
<text x="${f(bw - 16)}" y="67" text-anchor="end" class="mono" font-size="9.5" fill="#6e7681">/ ${goal.toLocaleString('en-US')}</text>
<text x="15" y="68" class="sans" font-size="34" font-weight="800" fill="${s.color}">${s.value.toLocaleString('en-US')}</text>
<rect x="16" y="84" width="${barW}" height="5" rx="2.5" fill="#1f2937"/>
<rect x="16" y="84" width="${f(fill)}" height="5" rx="2.5" fill="${s.color}" filter="url(#soft)"/>
<g clip-path="url(#bar${i})"><rect class="anim sheen" style="animation-delay:${i * 0.6}s" x="16" y="84" width="24" height="5" rx="2.5" fill="#ffffff" fill-opacity=".55"/></g>
<clipPath id="bar${i}"><rect x="16" y="84" width="${f(fill)}" height="5" rx="2.5"/></clipPath>
</g>`;
  }).join('\n');
  const body = `
<circle cx="${w - 26}" cy="26" r="3.2" fill="#60a5fa" class="breathe" filter="url(#soft)"/>
<text x="40" y="60" class="sans" font-size="25" font-weight="800" fill="#f0f6fc">Profile Signal</text>
<text x="41" y="80" class="mono" font-size="11" fill="#8b949e">Public GitHub metrics · synced ${d.generated} by GitHub Actions</text>
${boxes}
${signature(w, h)}`;
  return panel({
    w, h, title: 'Profile Signal — live GitHub stats',
    desc: stats.map((s) => `${s.label}: ${s.value}`).join(', ') + `. Synced ${d.generated}.`,
    defs: `<filter id="soft" x="-30%" y="-200%" width="160%" height="500%"><feGaussianBlur stdDeviation="1.8" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>`,
    style: `.sheen{opacity:0;animation:sheen 4.8s ease-in-out infinite}@keyframes sheen{0%{opacity:0;transform:translateX(0)}15%{opacity:1}55%{opacity:0;transform:translateX(${barW - 24}px)}100%{opacity:0;transform:translateX(${barW - 24}px)}}`,
    body,
  });
}

function footer() {
  const w = 880, h = 112, pw = 230, px = (w - pw) / 2, py = 34;
  const body = `
<g transform="translate(${px},${py})">
<rect width="${pw}" height="44" rx="22" fill="#050810" fill-opacity=".85" stroke="#e6edf3" stroke-opacity=".55"/>
<g transform="translate(16,10) scale(1.5)"><path fill="#e6edf3" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z"/></g>
<text x="52" y="18" class="mono" font-size="9" letter-spacing="2.2" fill="#8b949e">GITHUB</text>
<text x="52" y="33" class="mono" font-size="13.5" font-weight="700" fill="#f0f6fc">@${esc(USER)}</text>
</g>
${signature(w, h)}`;
  return panel({ w, h, title: `GitHub @${USER}`, desc: `Footer linking to github.com/${USER}.`, body });
}

// ---------------------------------------------------------------- main

// PROFILE_CACHE=<file> reuses one fetch across local design iterations
// (the unauthenticated API allows 60 requests an hour). Never set it in CI.
async function load() {
  const cache = process.env.PROFILE_CACHE;
  if (cache && existsSync(cache)) return JSON.parse(await readFile(cache, 'utf8'));
  const data = await collect();
  if (cache) await writeFile(cache, JSON.stringify(data));
  return data;
}

const d = await load();
const out = {
  'hero.svg': hero(d),
  'projects-header.svg': projectsHeader(d),
  'contribution-invaders.svg': invaders(d),
  'profile-signal.svg': signal(d),
  'footer.svg': footer(),
};
for (const p of d.projects) out[p.file] = card(p);

await mkdir(join(ROOT, 'assets'), { recursive: true });
await mkdir(join(ROOT, 'data'), { recursive: true });
for (const [name, svg] of Object.entries(out)) await writeFile(join(ROOT, 'assets', name), svg);

const { avatar, ...snapshot } = d;
snapshot.contributions = { total: d.contributions.total, source: d.contributions.source,
  weeks: d.contributions.weeks.length };
snapshot.projects = d.projects.map(({ lines, file, ...rest }) => rest);
await writeFile(join(ROOT, 'data', 'profile.json'), `${JSON.stringify(snapshot, null, 2)}\n`);

console.log(`stars=${d.stars} contributions=${d.contributions.total} (${d.contributions.source}) ` +
  `repos=${d.user.publicRepos} followers=${d.user.followers} langs=${d.topLanguages.join('/')}`);
