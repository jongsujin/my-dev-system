// 훅 공용 헬퍼. Node 내장 모듈만 사용한다.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
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

/**
 * .harness.json 상태. 없음과 깨짐을 구분해야 세션 시작에서 "파일이 없다"고 잘못 안내하지 않는다.
 * @returns {{status: 'missing'} | {status: 'broken', error: string} | {status: 'ok', config: object}}
 */
export function loadConfigState(root) {
  const p = join(root, CONFIG_FILE);
  if (!existsSync(p)) return { status: 'missing' };
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { status: 'broken', error: '최상위 값이 객체가 아닙니다' };
    return { status: 'ok', config: normalizeConfig(raw) };
  } catch (e) {
    return { status: 'broken', error: e?.message || String(e) };
  }
}

/** .harness.json 을 읽는다. 없거나 깨졌으면 null (게이트 비활성). */
export function loadConfig(root) {
  const s = loadConfigState(root);
  return s.status === 'ok' ? s.config : null;
}

const isObj = x => !!x && typeof x === 'object' && !Array.isArray(x);
/** 문자열 하나는 목록 하나로 받아 주고, 그 밖의 잘못된 형식은 빈 목록. */
const names = x => (typeof x === 'string' ? [x] : Array.isArray(x) ? x.filter(n => typeof n === 'string') : []);

/** 기본값을 채운 설정. 순수 함수 (테스트 대상). */
export function normalizeConfig(raw = {}) {
  const v = isObj(raw.verify) ? raw.verify : {};
  const g = raw.guard || {};
  return {
    verify: {
      commands: isObj(v.commands) ? v.commands : {},
      onEdit: typeof v.onEdit === 'string' && v.onEdit.trim() ? v.onEdit : null,
      onEditExtensions: Array.isArray(v.onEditExtensions) ? v.onEditExtensions : ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue'],
      onStop: names(v.onStop),
      onCommit: names(v.onCommit),
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

// ── 세션 상태 (tmpdir/my-harness/ 아래, 세션 id 별) ──

export const STATE_DIR = join(tmpdir(), 'my-harness');
/** 이보다 큰 파일은 내용 대신 크기+수정 시각으로 기록한다 (SessionStart 10초 제한). */
const HASH_SIZE_CAP = 5 * 1024 * 1024;

export function sessionKey(id) {
  return String(id || 'na').replace(/[^\w-]/g, '') || 'na';
}
export const counterPath = id => join(STATE_DIR, `stop-${sessionKey(id)}.json`);
export const baselinePath = id => join(STATE_DIR, `baseline-${sessionKey(id)}.json`);

export function readJson(p) {
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}
export function writeJson(p, obj) {
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(obj));
}

export function sha1(text) {
  return createHash('sha1').update(text).digest('hex');
}

/** 파일별 내용 해시. 지워진 파일·읽을 수 없는 경로는 표식 문자열. */
export function fileHashes(root, files) {
  const out = {};
  for (const f of files) {
    const p = join(root, f);
    try {
      const st = statSync(p);
      if (!st.isFile()) out[f] = `other:${st.mtimeMs}`;
      else if (st.size > HASH_SIZE_CAP) out[f] = `big:${st.size}:${st.mtimeMs}`;
      else out[f] = createHash('sha1').update(readFileSync(p)).digest('hex');
    } catch {
      out[f] = 'deleted';
    }
  }
  return out;
}

/**
 * 이번 세션에서 바뀐 파일. 순수 함수.
 * 기준선이 없으면 전부, 있으면 해시가 달라졌거나 기준선에 없던 파일만.
 * @param {Record<string,string>} current  지금 바뀐 파일 → 해시
 * @param {Record<string,string>|null} baseline 세션 시작 때 바뀌어 있던 파일 → 해시
 */
export function sessionChanges(current, baseline) {
  const files = Object.keys(current);
  if (!baseline) return files;
  return files.filter(f => baseline[f] !== current[f]);
}

export const MAX_BLOCKS = 3;

/**
 * Stop 훅의 다음 행동. 순수 함수.
 * - 연속 MAX_BLOCKS 번 막은 뒤에는 사용자에게 넘기고(handoff) 그때의 서명을 기억한다.
 * - 넘긴 뒤 서명이 같으면(아무것도 안 바뀜) 다시 막지 않고 안내만 반복한다(repeat).
 * @param {{count?: number, handoffSig?: string}} state
 * @param {{failed: boolean, block: boolean, signature: string}} now
 * @returns {{action: 'pass'|'block'|'advisory'|'handoff'|'repeat', next: object}}
 */
export function stopDecision(state, { failed, block, signature }) {
  const count = Number(state?.count) || 0;
  if (!failed) return { action: 'pass', next: { count: 0 } };
  if (!block) return { action: 'advisory', next: { count: 0 } };
  if (state?.handoffSig && state.handoffSig === signature) return { action: 'repeat', next: { count: 0, handoffSig: signature } };
  if (count >= MAX_BLOCKS) return { action: 'handoff', next: { count: 0, handoffSig: signature } };
  return { action: 'block', next: { count: count + 1 } };
}

/** 설정의 명령 이름 목록을 실제 명령으로 바꾼다. 없는 이름은 건너뛴다. */
export function resolveCommands(names, commands) {
  if (!Array.isArray(names) || !isObj(commands)) return [];
  return names.map(n => ({ name: n, cmd: commands[n] })).filter(x => typeof x.cmd === 'string' && x.cmd.trim());
}

/** onStop·onCommit 에 적었지만 verify.commands 에 없는(또는 빈) 이름. 순수 함수. */
export function unknownCommandNames(verify) {
  const cmds = isObj(verify?.commands) ? verify.commands : {};
  const missing = list => names(list).filter(n => !(typeof cmds[n] === 'string' && cmds[n].trim()));
  return { onStop: missing(verify?.onStop), onCommit: missing(verify?.onCommit) };
}

export function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

export function skipped() {
  return process.env.HARNESS_SKIP === '1';
}
