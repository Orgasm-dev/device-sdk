#!/usr/bin/env node
// What this repository's files and prose may not contain.
//
//   node scripts/policy.mjs tree             every file git tracks or would track
//   node scripts/policy.mjs text <file>...   prose: commit messages, pull request text
//
// Refused:
//   - words from a restricted list, matched by SHA-256 prefix of each lowercased
//     word and of each pair of adjacent words, so that the list itself is not in
//     this repository; a match is reported by its hash, never printed. The
//     enclave's public references and the literals of its wire protocol
//     (PERMITTED) are the one exception: the SDK links the source it speaks to
//     and sends the header names and the seal salt the enclave expects
//   - internal evaluation figures (precision, recall, accuracy, F1, AUC, mAP)
//   - work-in-progress markers
//   - personal e-mail addresses
//   - private keys and live secret keys
//
// Exit status 1 on any finding; findings print as GitHub annotations.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const RESTRICTED = new Set([
  '102cf10b5286bad9', '1b9abd6ff544b7be', '243467a42f96a799', '38809d9c6247db50',
  '4772cde92836adf6', '8984228f3b9ff2df', 'b4dc10345e15f73e', 'b9a741c0601883de', 'bcb9209dc4fd8180',
  'cf65dee8f1e5255c', 'da1228967c66d3b5', 'e12b91523bb8e253',
]);

// Exactly these references, followed by a path, a digest or nothing; a name that
// continues them is checked like any other word.
const PERMITTED = [
  'github.com/Masseuse-ai/masseuse-video-tee',
  'ghcr.io/masseuse-ai/masseuse-video-tee',
  'X-Masseuse-Evidence',
  'X-Masseuse-Seal',
  'X-Masseuse-Client-Nonce',
  'x-masseuse-',
  'masseuse-video-tee seal v1',
];
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
const PERMITTED_RE = new RegExp(`(?:${PERMITTED.map(escapeRe).join('|')})(?![A-Za-z0-9_-])`, 'gi');

const METRICS = [/\b(?:precision|recall|accuracy)\b/i, /\bF1\b/, /\bAUC\b/, /\bmAP\b/, /\bF-?score\b/i];
const MARKERS = new RegExp(`\\b(?:${['TO', 'DO'].join('')}|${['FIX', 'ME'].join('')}|XXX|HACK|WIP)\\b`);
const PERSONAL_EMAIL = /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|icloud|me|mac|outlook|hotmail|live|msn|yahoo|ymail|aol|proton|protonmail|pm|fastmail|hey)\.(?:com|me|ch|net|org)\b/i;
const SECRETS = [/-----BEGIN [A-Z ]*PRIVATE KEY-----/, /\bsk_live_[A-Za-z0-9]{16,}\b/];

// SVG is text (markup, no embedded prose for the icons here) and is scanned; the
// other listed extensions are binary and skipped.
const SKIP = /(^|\/)(node_modules|dist|coverage)\/|(^|\/)package-lock\.json$|(^|\/)scripts\/policy\.mjs$|\.(png|jpg|jpeg|gif|webp|avif|ico|woff2?|ttf|mp4|webm)$/;

const hash = (token) => createHash('sha256').update(token).digest('hex').slice(0, 16);

const findings = [];
const report = (file, line, message) => findings.push({ file, line, message });

function checkLine(file, line, text) {
  const words = text.replace(PERMITTED_RE, ' ').toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (let i = 0; i < words.length; i++) {
    for (const token of i + 1 < words.length ? [words[i], words[i] + words[i + 1]] : [words[i]]) {
      const h = hash(token);
      if (RESTRICTED.has(h)) report(file, line, `restricted word (sha256 ${h})`);
    }
  }
  for (const re of METRICS) if (re.test(text)) report(file, line, `internal evaluation figure: ${re}`);
  if (MARKERS.test(text)) report(file, line, 'work-in-progress marker');
  if (PERSONAL_EMAIL.test(text)) report(file, line, 'personal e-mail address');
  for (const re of SECRETS) if (re.test(text)) report(file, line, 'secret material');
}

function checkFile(file, content) {
  checkLine(file, 0, file);
  content.split('\n').forEach((text, i) => checkLine(file, i + 1, text));
}

function trackedFiles() {
  const listed = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
  if (listed.status !== 0) throw new Error(`git ls-files failed: ${listed.stderr}`);
  return listed.stdout.split('\n').filter((f) => f && !SKIP.test(f));
}

const [mode, ...args] = process.argv.slice(2);
if (mode === 'tree') {
  for (const file of trackedFiles()) {
    let content;
    try {
      content = readFileSync(file, 'utf8');
    } catch {
      continue;
    }
    checkFile(file, content);
  }
} else if (mode === 'text') {
  for (const file of args) checkFile(file, readFileSync(file, 'utf8'));
} else {
  console.error('usage: policy.mjs tree | text <file>...');
  process.exit(2);
}

for (const f of findings) console.log(`::error file=${f.file},line=${f.line}::${f.message}`);
if (findings.length) {
  console.error(`${findings.length} finding(s)`);
  process.exit(1);
}
console.log('policy: no findings');
