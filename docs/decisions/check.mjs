#!/usr/bin/env node
// 决策记录校验：node docs/decisions/check.mjs
// 检查目录结构、文件名、头部格式、Status 与目录一致、骨架段落、implemented 禁词、归档标记与活跃记录死链。零依赖。
import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const root = dirname(fileURLToPath(import.meta.url));
const errors = [];

if (existsSync(join(root, 'INDEX.md'))) {
  errors.push('INDEX.md: 禁止创建集中式索引，请按状态目录浏览或全文搜索');
}

function listMd(dir) {
  const p = join(root, dir);
  if (!existsSync(p)) return [];
  return readdirSync(p)
    .filter((f) => f.endsWith('.md') && f !== '.gitkeep.md')
    .map((f) => join(p, f));
}

function stripFences(lines) {
  let inFence = false;
  return lines.filter((line) => {
    if (/^\s*```/.test(line)) {
      inFence = !inFence;
      return false;
    }
    return !inFence;
  });
}

const SECTIONS = {
  implemented: ['## Problem', '## Decision', '## Alternatives considered', '## Consequences'],
  proposed: ['## Problem', '## Proposal', '## Alternatives considered', '## Acceptance criteria', '## Risks'],
  rejected: ['## Problem', '## Proposal'],
};

const BANNED_IMPLEMENTED = /^## (?:Proposal\b|Plan\b|Migration plan\b|Acceptance criteria\b)/i;

function check(file, lifecycle, text) {
  const short = file.slice(root.length + 1);
  const name = basename(file);
  if (!/^\d{4}-\d{2}-\d{2}-.+\.md$/.test(name)) {
    errors.push(short + ': 文件名必须为 yyyy-mm-dd-slug.md');
  }

  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const prose = stripFences(lines);

  if (!/^# DR:\s+\S/.test(lines[0] ?? '')) errors.push(short + ': 第 1 行必须是 "# DR: <标题>"');
  if ((lines[1] ?? '') !== '') errors.push(short + ': 第 2 行必须是空行');

  const statusLine = lines[2] ?? '';
  if (!/^Status:\s*.+$/.test(statusLine)) {
    errors.push(short + ': 第 3 行必须是 "Status: <状态>"');
  } else {
    const v = statusLine.replace(/^Status:\s*/, '').trim();
    if (lifecycle === 'rejected' && !/^rejected\s+—\s+\S/.test(v)) {
      errors.push(short + ': rejected 记录的 Status 必须是 "rejected — 一行理由": ' + v);
    } else if (lifecycle === 'archived') {
      if (v !== 'implemented') errors.push(short + ': archived 记录的 Status 必须仍为 implemented: ' + v);
      if (!prose.some((l) => /^Archived:\s*\d{4}-\d{2}-\d{2}\s*$/.test(l))) {
        errors.push(short + ': 缺少 "Archived: yyyy-mm-dd" 行');
      }
    } else if (lifecycle !== 'rejected' && v !== lifecycle) {
      errors.push(short + ': Status "' + v + '" 与目录 ' + lifecycle + '/ 不一致');
    }
  }

  const expectedBlankAfterHeader = lifecycle === 'archived' ? 4 : 3;
  if (lifecycle === 'archived' && !/^Archived:\s*\d{4}-\d{2}-\d{2}\s*$/.test(lines[3] ?? '')) {
    errors.push(short + ': archived 记录第 4 行必须是 "Archived: yyyy-mm-dd"');
  }
  if ((lines[expectedBlankAfterHeader] ?? '') !== '') {
    errors.push(short + ': 第 ' + (expectedBlankAfterHeader + 1) + ' 行（头部之后）必须是空行');
  }

  const extraStatus = prose.filter((l) => /^Status:\s*/.test(l));
  if (extraStatus.length > 1) errors.push(short + ': 全文只能有一处 Status 行');

  const h2s = prose.filter((l) => l.startsWith('## ')).map((l) => l.trimEnd());
  if (h2s[0] !== '## Problem') {
    errors.push(short + ': 第一个二级标题必须是 "## Problem"（当前为 ' + (h2s[0] ?? '<无>') + '）');
  }

  const skeleton = lifecycle === 'archived' ? SECTIONS.implemented : SECTIONS[lifecycle];
  if (skeleton) {
    for (const s of skeleton) {
      if (!h2s.includes(s)) errors.push(short + ': 缺少段落 ' + s);
    }
  }

  if (lifecycle === 'implemented') {
    for (const h2 of h2s) {
      if (BANNED_IMPLEMENTED.test(h2)) {
        errors.push(short + ': implemented 记录禁止出现规划性段落 "' + h2 + '"');
      }
    }
  }

  if (lifecycle === 'archived') return;

  const proseText = prose.join('\n');
  const re = /\]\(([^)]+)\)/g;
  let lm;
  while ((lm = re.exec(proseText))) {
    const raw = lm[1];
    if (/^[a-z][a-z0-9+.-]*:/i.test(raw)) continue;
    const target = raw.split('#')[0];
    if (!target) continue;
    if (!existsSync(resolve(dirname(file), target))) errors.push(short + ': 死链 ' + target);
  }
}

let count = 0;
for (const lifecycle of ['proposed', 'implemented', 'rejected', 'archived']) {
  for (const file of listMd(lifecycle)) {
    count++;
    check(file, lifecycle, readFileSync(file, 'utf8'));
  }
}
if (errors.length) {
  console.error('决策记录校验失败:\n' + errors.join('\n'));
  process.exit(1);
}
console.log('决策记录校验通过: ' + count + ' 条记录');
