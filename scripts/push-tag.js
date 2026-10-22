#!/usr/bin/env node
'use strict';
/* push-tag.js — пуш ветки и тега без участия шелла.
 *
 * Зачем отдельный скрипт: в `sh` подстановка `$(grep ... | sed ...)` с
 * кавычками вокруг токена разваливается на экранировании (`)" unexpected`),
 * причём уже после того, как локальные шаги прошли. Здесь токен читается в
 * JS и передаётся git через URL; в вывод он не попадает — маскируется.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');

const REPO = '/home/node/.openclaw/workspace-main/backend-api';
const CRED_ROOT = '/home/node/.openclaw/credentials/github/personal';

function findHostsYml() {
  if (!fs.existsSync(CRED_ROOT)) throw new Error(`нет каталога кредов: ${CRED_ROOT}`);
  for (const dir of fs.readdirSync(CRED_ROOT)) {
    const p = path.join(CRED_ROOT, dir, 'hosts.yml');
    if (fs.existsSync(p)) return p;
  }
  throw new Error(`hosts.yml не найден в ${CRED_ROOT}/*/`);
}

function readToken(file) {
  const text = fs.readFileSync(file, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^\s*oauth_token:\s*(.+?)\s*$/);
    if (m) return m[1].replace(/^["']|["']$/g, '').trim();
  }
  throw new Error('поле oauth_token не найдено в hosts.yml');
}

const mask = (s) => String(s).replace(/x-access-token:[^@\s]+/g, 'x-access-token:***');

function git(args, opts = {}) {
  try {
    const out = execFileSync('git', args, {
      cwd: REPO,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      ...opts,
    });
    return { ok: true, out: mask(out) };
  } catch (e) {
    return { ok: false, out: mask(`${e.stdout || ''}${e.stderr || ''}`), code: e.status };
  }
}

const hosts = findHostsYml();
const token = readToken(hosts);
if (token.length < 20) throw new Error(`токен подозрительно короткий: ${token.length}`);

console.log(`креды: ${hosts}`);
console.log(`токен: ${token.length} символов`);

const url = `https://x-access-token:${token}@github.com/pdkiller666/tarnet-backend.git`;
const tag = process.argv[2];
if (!tag) throw new Error('укажи тег: node push-tag.js <tag>');

const branch = git(['-c', 'credential.helper=', 'push', url, 'HEAD:refs/heads/main']);
console.log('== ветка ==');
console.log(branch.out.trim() || '(пусто)');
if (!branch.ok) { console.error('ПУШ ВЕТКИ НЕ УДАЛСЯ'); process.exit(1); }

const tagPush = git(['-c', 'credential.helper=', 'push', url, `refs/tags/${tag}`]);
console.log('== тег ==');
console.log(tagPush.out.trim() || '(пусто)');
if (!tagPush.ok) { console.error('ПУШ ТЕГА НЕ УДАЛСЯ'); process.exit(1); }

/* Проверка независимо от вывода пуша: смотрим, что реально лежит на GitHub. */
const ls = git(['ls-remote', url, `refs/tags/${tag}`, `refs/tags/${tag}^{}`, 'refs/heads/main']);
console.log('== ls-remote ==');
console.log(ls.out.trim());
process.exit(ls.ok ? 0 : 1);
