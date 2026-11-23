// 훅 공용 헬퍼. Node 내장 모듈만 사용한다.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

export const CONFIG_FILE = '.harness.json';

/** 훅 입력(JSON)을 stdin 에서 읽는다. 실패하면 빈 객체. */
export async function readInput() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch { return {}; }
}

/** 프로젝트 루트: git 최상위, 아니면 cwd. */
export function projectRoot(cwd) {
  const base = cwd || process.env.CLAUDE_PROJECT_DIR || process.cwd();
  const r = spawnSync('git', ['rev-parse', '--show-toplevel'], { cwd: base, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : base;
}

/** .harness.json 을 읽는다. 없거나 깨졌으면 null (게이트 비활성). */
export function loadConfig(root) {
  const p = join(root, CONFIG_FILE);
  if (!existsSync(p)) return null;
  try { return normalizeConfig(JSON.parse(readFileSync(p, 'utf8'))); } catch { return null; }
}

/** 기본값을 채운 설정. 순수 함수 (테스트 대상). */
export function normalizeConfig(raw = {}) {
  const v = raw.verify || {};
  const g = raw.guard || {};
  return {
    verify: {
      commands: v.commands || {},
      onEdit: v.onEdit || null,
      onEditExtensions: v.onEditExtensions || ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
      onStop: v.onStop || [],
      onCommit: v.onCommit || [],
    },
    gates: { block: raw.gates?.block !== false },
    guard: {
      protectedBranches: g.protectedBranches || ['main', 'master'],
      deny: g.deny || [],
      ask: g.ask || [],
    },
    review: {
      base: raw.review?.base || 'main',
      reviewers: raw.review?.reviewers || ['security', 'quality', 'frontend', 'convention', 'test'],
    },
    context: {
      rules: raw.context?.rules || ['common'],
      maxLessons: raw.context?.maxLessons ?? 6,
    },
  };
}

/** 셸 명령 실행. { ok, out } — out 은 stdout+stderr 마지막 부분. */
export function run(cmd, cwd, timeoutMs = 180_000) {
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024 });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out: tail(out, 40) };
}

export function tail(text, lines) {
  return text.trimEnd().split('\n').slice(-lines).join('\n');
}

/** 작업 트리에서 바뀐 파일 (스테이징·미스테이징·추적 안 된 파일). */
export function changedFiles(root) {
  const a = spawnSync('git', ['diff', '--name-only', 'HEAD'], { cwd: root, encoding: 'utf8' });
  const b = spawnSync('git', ['ls-files', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8' });
  const names = `${a.stdout || ''}\n${b.stdout || ''}`.split('\n').map(s => s.trim()).filter(Boolean);
  return [...new Set(names)];
}

/** 설정의 명령 이름 목록을 실제 명령으로 바꾼다. 없는 이름은 건너뛴다. */
export function resolveCommands(names, commands) {
  return names.map(n => ({ name: n, cmd: commands[n] })).filter(x => typeof x.cmd === 'string' && x.cmd.trim());
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

export function skipped() {
  return process.env.HARNESS_SKIP === '1';
}
