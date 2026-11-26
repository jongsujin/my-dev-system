#!/usr/bin/env node
// 리뷰 리포트(.harness/reviews/*.json)의 발견을 적용하기 전에, 근거가 지금 코드에 그대로 있는지
// 결정적으로 확인하고 바로 적용 / 확인 후 적용 / 안내만 / 적용하지 않음으로 나눈다.
// Claude Code·Codex 어디서든 스킬 폴더 기준으로 실행되도록 hooks/scripts 를 불러오지 않는다.
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUSES = ['open', 'applied', 'skipped'];
export const DEFAULT_PROTECT = [
  'package.json', '**/package.json', 'package-lock.json', '**/package-lock.json',
  'pnpm-lock.yaml', '**/pnpm-lock.yaml', 'yarn.lock', '**/yarn.lock', '**/*.lock',
  '**/migrations/**', '.harness.json',
];
const NEAR_LINES = 3;
const MAX_CANDIDATES = 5;

class PlanError extends Error {}

/** 최소 glob: `**\/` 는 0개 이상 디렉터리, `**` 는 무엇이든, `*` 는 `/` 를 뺀 무엇이든. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
    } else if (c === '*') re += '[^/]*';
    else re += c.replace(/[.+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const matchesAny = (path, globs) => globs.some(g => globToRegExp(g).test(path));

function git(cwd, args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  return r.status === 0 ? r.stdout : null;
}

export function repoRoot(cwd) {
  return git(cwd, ['rev-parse', '--show-toplevel'])?.trim() || cwd;
}

/** 설정이 깨져 있어도 적용을 막지 않도록 기본 보호 목록으로 돌아간다. */
export function loadProtect(root) {
  try {
    const p = JSON.parse(readFileSync(join(root, '.harness.json'), 'utf8'))?.review?.protect;
    if (Array.isArray(p) && p.every(s => typeof s === 'string')) return p;
  } catch { /* 기본값 사용 */ }
  return DEFAULT_PROTECT;
}

export function validateReport(r) {
  if (!r || typeof r !== 'object' || !Array.isArray(r.findings)) return 'findings 배열이 없습니다';
  for (const [i, f] of r.findings.entries()) {
    for (const k of ['id', 'severity', 'file', 'evidence', 'fix']) {
      if (!f || typeof f[k] !== 'string' || !f[k]) return `발견 ${i + 1}번에 ${k} 가 없습니다`;
    }
    if (f.status !== undefined && !STATUSES.includes(f.status)) return `발견 ${f.id} 의 status 가 올바르지 않습니다: ${f.status}`;
  }
  return null;
}

export function readReport(path) {
  let report;
  try { report = JSON.parse(readFileSync(path, 'utf8')); } catch (e) {
    throw new PlanError(`리뷰 리포트를 읽을 수 없습니다: ${path} (${e.message})`);
  }
  const bad = validateReport(report);
  if (bad) throw new PlanError(`리뷰 리포트 형식이 아닙니다: ${path} — ${bad}`);
  return report;
}

/** createdAt 이 가장 늦은 리포트. 읽을 수 없으면 파일 수정 시각으로 비교한다. */
export function findLatestReport(root) {
  const dir = join(root, '.harness', 'reviews');
  const files = existsSync(dir) ? readdirSync(dir).filter(f => f.endsWith('.json')) : [];
  let best = null;
  for (const f of files) {
    const path = join(dir, f);
    let t = NaN;
    try { t = Date.parse(JSON.parse(readFileSync(path, 'utf8')).createdAt); } catch { /* mtime 사용 */ }
    if (Number.isNaN(t)) t = statSync(path).mtimeMs;
    if (!best || t > best.t) best = { path, t };
  }
  if (!best) throw new PlanError('리뷰 리포트(.harness/reviews/*.json)가 없습니다. review 스킬을 먼저 실행하세요.');
  return best.path;
}

const norm = s => s.split(/\r?\n/).map(l => l.trim());

/** 근거 줄들이 파일에서 연속으로(들여쓰기 무시) 나오는 시작 줄 번호 목록 (1부터). */
export function findMatches(fileText, evidence) {
  const ev = norm(evidence).filter(Boolean);
  if (!ev.length) return [];
  const lines = norm(fileText);
  const out = [];
  for (let i = 0; i + ev.length <= lines.length; i++) {
    if (ev.every((e, j) => lines[i + j] === e)) out.push(i + 1);
  }
  return out;
}

/** 근거에서 가장 긴 식별자 토큰이 있는 줄. 코드가 조금 바뀐 자리를 짚어 주기 위한 것. */
export function driftCandidates(fileText, evidence) {
  const tokens = evidence.match(/[A-Za-z_$][\w$]{3,}/g) || [];
  if (!tokens.length) return [];
  const token = tokens.reduce((a, b) => (b.length > a.length ? b : a));
  const out = [];
  fileText.split(/\r?\n/).forEach((l, i) => {
    if (out.length < MAX_CANDIDATES && l.includes(token)) out.push({ line: i + 1, text: l.trim().slice(0, 120) });
  });
  return out;
}

export function locate(root, finding, protect) {
  const file = finding.file;
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (isAbsolute(file) || rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { status: 'invalid-path' };
  const posix = rel.split('\\').join('/');
  if (matchesAny(posix, protect)) return { status: 'protected' };
  if (!existsSync(abs) || !statSync(abs).isFile()) return { status: 'missing-file' };
  const text = readFileSync(abs, 'utf8');
  const span = norm(finding.evidence).filter(Boolean).length;
  const matches = findMatches(text, finding.evidence);
  const exact = line => ({ status: 'exact', line, endLine: line + span - 1 });
  if (matches.length === 1) return exact(matches[0]);
  if (matches.length > 1) {
    if (Number.isInteger(finding.line)) {
      const near = matches.filter(m => Math.abs(m - finding.line) <= NEAR_LINES);
      if (near.length === 1) return exact(near[0]);
    }
    return { status: 'ambiguous', candidates: matches.slice(0, MAX_CANDIDATES) };
  }
  const candidates = driftCandidates(text, finding.evidence);
  return candidates.length ? { status: 'drift', candidates } : { status: 'gone' };
}

const REASONS = {
  'invalid-path': '경로가 레포 밖이거나 절대 경로',
  protected: '보호 파일 (review.protect)',
  'missing-file': '파일이 없음',
  gone: '근거 코드가 이미 바뀌었거나 사라짐',
  ambiguous: '근거가 여러 곳에 있음',
  drift: '근거가 정확히 일치하지 않음',
};

export function bucketOf(f, loc, conflicts, opts) {
  if (['invalid-path', 'protected', 'missing-file', 'gone'].includes(loc.status)) return 'blocked';
  const sevOk = f.severity === 'critical' || (f.severity === 'major' && opts.autoMajor);
  if (f.verified === true && f.autoApplicable === true && loc.status === 'exact' && !conflicts.length && sevOk) return 'auto';
  if (f.severity === 'minor' && !opts.withMinor) return 'info';
  return 'confirm';
}

function reasonOf(f, loc, conflicts) {
  if (REASONS[loc.status]) return REASONS[loc.status];
  if (conflicts.length) return `같은 자리를 고치는 발견과 겹침: ${conflicts.join(', ')}`;
  return undefined;
}

function gitWarnings(root, report) {
  const warnings = [];
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (head && report.head && head !== report.head) {
    warnings.push(`리뷰 이후 커밋이 추가됨 (리뷰 ${report.head.slice(0, 8)} → 현재 ${head.slice(0, 8)}). 근거 위치가 달라졌을 수 있습니다.`);
  }
  const status = git(root, ['status', '--porcelain']);
  const n = status ? status.split('\n').filter(Boolean).length : 0;
  if (n >= 10) warnings.push(`커밋하지 않은 변경이 ${n}개 있습니다. 적용한 수정이 기존 변경과 섞입니다.`);
  return warnings;
}

export function buildPlan(root, reportPath, report, opts = {}) {
  const protect = loadProtect(root);
  const open = report.findings.filter(f => (f.status ?? 'open') === 'open');
  const located = open.map(f => ({ f, loc: locate(root, f, protect) }));
  const conflicts = new Map(located.map(({ f }) => [f.id, []]));
  for (let i = 0; i < located.length; i++) {
    for (let j = i + 1; j < located.length; j++) {
      const a = located[i], b = located[j];
      if (a.loc.status !== 'exact' || b.loc.status !== 'exact' || resolve(root, a.f.file) !== resolve(root, b.f.file)) continue;
      if (a.loc.line <= b.loc.endLine && b.loc.line <= a.loc.endLine) {
        conflicts.get(a.f.id).push(b.f.id);
        conflicts.get(b.f.id).push(a.f.id);
      }
    }
  }
  const items = located.map(({ f, loc }) => {
    const cw = conflicts.get(f.id);
    const item = {
      id: f.id, severity: f.severity, category: f.category, file: f.file, line: f.line, title: f.title,
      bucket: bucketOf(f, loc, cw, opts), locate: loc, conflictsWith: cw,
    };
    const reason = reasonOf(f, loc, cw);
    if (reason) item.reason = reason;
    return item;
  });
  const counts = { auto: 0, confirm: 0, info: 0, blocked: 0, done: report.findings.length - open.length };
  for (const it of items) counts[it.bucket]++;
  const files = [...new Set(items.filter(it => it.bucket === 'auto' || it.bucket === 'confirm').map(it => it.file))];
  return { report: reportPath, warnings: gitWarnings(root, report), counts, items, files };
}

const SECTIONS = [['auto', '바로 적용'], ['confirm', '확인 후 적용'], ['info', '안내만'], ['blocked', '적용하지 않음']];

export function formatPlan(plan) {
  const c = plan.counts;
  const out = [
    `리포트: ${plan.report}`,
    `바로 적용 ${c.auto} / 확인 후 적용 ${c.confirm} / 안내만 ${c.info} / 적용하지 않음 ${c.blocked} / 이미 처리됨 ${c.done}`,
  ];
  if (plan.warnings.length) out.push('', '주의:', ...plan.warnings.map(w => `- ${w}`));
  for (const [key, label] of SECTIONS) {
    const list = plan.items.filter(it => it.bucket === key);
    if (!list.length) continue;
    out.push('', `-- ${label} --`);
    for (const it of list) {
      const line = it.locate.line ?? it.line;
      out.push(`${it.id} ${it.severity} ${it.file}${line ? `:${line}` : ''} ${it.title ?? ''}`.trimEnd());
      if (it.reason) out.push(`    ${it.reason}`);
      for (const cand of it.locate.candidates ?? []) {
        out.push(typeof cand === 'number' ? `    후보 ${it.file}:${cand}` : `    후보 ${it.file}:${cand.line} ${cand.text}`);
      }
    }
  }
  if (plan.files.length) out.push('', '바뀔 수 있는 파일:', ...plan.files.map(f => `- ${f}`));
  return out.join('\n');
}

export function markFinding(reportPath, id, status) {
  if (!STATUSES.includes(status) || status === 'open') {
    throw new PlanError(`상태는 applied 또는 skipped 만 쓸 수 있습니다: ${status}`);
  }
  const report = readReport(reportPath);
  const f = report.findings.find(x => x.id === id);
  if (!f) throw new PlanError(`리포트에 ${id} 발견이 없습니다: ${reportPath}`);
  f.status = status;
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);
}

export function main(argv, cwd = process.cwd()) {
  const root = repoRoot(cwd);
  if (argv[0] === 'mark') {
    const [, path, id, status] = argv;
    if (!path || !id || !status) throw new PlanError('사용법: apply-plan.mjs mark <report.json> <id> <applied|skipped>');
    markFinding(resolve(cwd, path), id, status);
    return `${id} → ${status}`;
  }
  const flags = new Set(argv.filter(a => a.startsWith('--')));
  const pos = argv.find(a => !a.startsWith('--'));
  const reportPath = pos ? resolve(cwd, pos) : findLatestReport(root);
  const plan = buildPlan(root, reportPath, readReport(reportPath), {
    autoMajor: flags.has('--auto-major'), withMinor: flags.has('--with-minor'),
  });
  return flags.has('--json') ? JSON.stringify(plan, null, 2) : formatPlan(plan);
}

// 심볼릭 링크 경로로 실행돼도(예: macOS 의 /tmp) 직접 실행으로 알아보도록 실제 경로로 비교한다.
const realOrSelf = p => { try { return realpathSync(p); } catch { return resolve(p); } };
if (process.argv[1] && realOrSelf(process.argv[1]) === realOrSelf(fileURLToPath(import.meta.url))) {
  try {
    console.log(main(process.argv.slice(2)));
  } catch (e) {
    if (!(e instanceof PlanError)) throw e;
    console.error(e.message);
    process.exit(1);
  }
}
