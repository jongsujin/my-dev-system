// 훅 공용 헬퍼. Node 내장 모듈만 사용한다.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PLUGIN_ROOT = process.env.CLAUDE_PLUGIN_ROOT || process.env.PLUGIN_ROOT
  || resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/** 'claude' | 'codex'. Codex 훅 설정(codex-hooks.json)이 HARNESS_PLATFORM=codex 를 넘긴다. */
export const PLATFORM = process.env.HARNESS_PLATFORM === 'codex' ? 'codex' : 'claude';

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

/**
 * 셸 명령 실행. { ok, out } — out 은 stdout+stderr 마지막 부분.
 * extraEnv 는 자식 환경에 더한다. 사용자 입력(파일 경로 등)은 명령 문자열에 끼우지 말고 이걸로 넘긴다.
 */
export function run(cmd, cwd, timeoutMs = 180_000, extraEnv) {
  const env = extraEnv ? { ...process.env, ...extraEnv } : process.env;
  const r = spawnSync(cmd, { cwd, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 20 * 1024 * 1024, env });
  const out = `${r.stdout || ''}${r.stderr || ''}`;
  return { ok: r.status === 0, out: tail(out, 40) };
}

/**
 * onEdit 명령의 {file} 을 "$HARNESS_FILE" 로 바꾼다. 순수 함수.
 * 경로를 문자열로 끼우면 `a$(touch x).ts` 같은 파일 이름이 셸에서 실행되므로,
 * 경로는 환경 변수로만 넘기고 명령에는 변수 참조만 둔다.
 * 사용자가 이미 "{file}" 이나 '{file}' 로 감쌌으면 그 따옴표째 바꾼다
 * (작은따옴표 안에서는 변수가 펼쳐지지 않으므로 큰따옴표로 바꿔야 한다).
 */
export function fileCommand(template) {
  return String(template)
    .replaceAll('"{file}"', '"$HARNESS_FILE"')
    .replaceAll("'{file}'", '"$HARNESS_FILE"')
    .replaceAll('{file}', '"$HARNESS_FILE"');
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
