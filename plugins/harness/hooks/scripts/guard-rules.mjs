// 위험 명령 판단. 순수 함수만 둔다 (tests/guard.test.mjs).
//
// 결과: { decision: 'allow' | 'ask' | 'deny', reason?: string }
//  - deny: 실행 자체를 막는다. 되돌릴 수 없고 의도적일 가능성이 낮은 명령.
//  - ask : 사용자에게 확인을 받는다. 정당한 쓰임도 있는 명령.

import { isAbsolute, join } from 'node:path';

/**
 * 명령 줄을 구간(;, &&, ||, |, &, 줄바꿈, 괄호)과 토큰으로 나눈다. 따옴표·역슬래시를 존중한다.
 * 완전한 셸 파서는 아니다. `echo "git commit"` 을 git 명령으로 오인하지 않을 정도가 목표.
 * @returns {string[][]}
 */
export function tokenize(command) {
  const s = String(command || '');
  const segments = [];
  let tokens = [], cur = '', inToken = false, quote = null;
  const endToken = () => { if (inToken) tokens.push(cur); cur = ''; inToken = false; };
  const endSeg = () => { endToken(); if (tokens.length) segments.push(tokens); tokens = []; };
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (quote === "'") { if (c === "'") quote = null; else cur += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (c === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) cur += s[++i];
      else cur += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; inToken = true; continue; }
    if (c === '\\') { if (i + 1 < s.length && s[i + 1] !== '\n') { cur += s[++i]; inToken = true; } else i++; continue; }
    if (/\s/.test(c) && c !== '\n') { endToken(); continue; }
    if (c === '&' && s[i + 1] !== '&' && (s[i - 1] === '>' || s[i - 1] === '<' || s[i + 1] === '>')) { cur += c; inToken = true; continue; }
    if (';&|\n()'.includes(c)) {
      endSeg();
      if ((c === '&' || c === '|') && (s[i + 1] === c || (c === '|' && s[i + 1] === '&'))) i++;
      continue;
    }
    cur += c; inToken = true;
  }
  endSeg();
  return segments;
}

const ENV_ASSIGN = /^[A-Za-z_][A-Za-z0-9_]*=/;
const WRAPPERS = new Set(['sudo', 'env', 'command', 'exec', 'nohup', 'time']);
// 값을 다음 토큰으로 받는 git 전역 옵션 (= 로 붙여 쓸 수도 있다)
const GIT_OPT_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env', '--super-prefix']);

/**
 * 구간 하나의 토큰에서 git 하위 명령을 찾는다. sudo·env·VAR=값 접두와 git 전역 옵션을 건너뛴다.
 * @returns {{sub: string, args: string[], dir: string|null} | null}
 */
export function parseGit(tokens) {
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (ENV_ASSIGN.test(t)) { i++; continue; }
    if (WRAPPERS.has(t)) { i++; while (i < tokens.length && (tokens[i].startsWith('-') || ENV_ASSIGN.test(tokens[i]))) i++; continue; }
    break;
  }
  const g = tokens[i];
  if (g !== 'git' && !(g && g.endsWith('/git'))) return null;
  let dir = null;
  for (i++; i < tokens.length; i++) {
    const t = tokens[i];
    if (!t.startsWith('-')) return { sub: t, args: tokens.slice(i + 1), dir };
    if (GIT_OPT_WITH_VALUE.has(t)) {
      const v = tokens[++i];
      if (t === '-C' && v !== undefined) dir = dir && !isAbsolute(v) ? join(dir, v) : v;
      continue;
    }
    // 나머지(--no-pager, -p, --paginate, --bare, --exec-path[=…], --git-dir=… 등)는 값 없는 옵션으로 본다
  }
  return null;
}

function gitCommands(command) {
  return tokenize(command).map(parseGit).filter(Boolean);
}

/** 짧은 플래그 묶음(-uf 등)에 해당 글자가 있는지. */
function hasShort(args, ch) {
  return args.some(a => /^-[a-zA-Z]+$/.test(a) && a.includes(ch));
}

// 값을 다음 토큰으로 받는 push 옵션
const PUSH_OPT_WITH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec']);

function parsePush(args) {
  const flags = [], positional = [];
  let endOfFlags = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!endOfFlags && a === '--') { endOfFlags = true; continue; }
    if (!endOfFlags && a.startsWith('-') && a.length > 1) {
      flags.push(a);
      if (PUSH_OPT_WITH_VALUE.has(a)) i++;
      continue;
    }
    positional.push(a);
  }
  return { flags, remote: positional[0], refspecs: positional.slice(1) };
}

function isForcePush(push) {
  return push.flags.includes('--force') || hasShort(push.flags, 'f') || push.refspecs.some(r => r.startsWith('+'));
}

/** 푸시 대상 브랜치 이름들. 리프스펙이 없으면 현재 브랜치. */
function pushTargets(push, currentBranch) {
  if (push.refspecs.length === 0) return currentBranch ? [currentBranch] : [];
  return push.refspecs.map(ref => {
    let dst = ref.replace(/^\+/, '');
    if (dst.includes(':')) dst = dst.split(':').pop();
    if (dst === 'HEAD') dst = currentBranch || 'HEAD';
    return dst.replace(/^refs\/heads\//, '');
  });
}

/** 명령 안의 git push 가 실행될 -C 경로. push 가 없으면 undefined, -C 가 없으면 null. */
export function pushDir(command) {
  const p = gitCommands(command).find(g => g.sub === 'push');
  return p ? p.dir : undefined;
}

const FORCE_PUSH_REASON = '강제 푸시는 차단합니다. 꼭 필요하면 --force-with-lease 로, 사용자 확인 후 직접 실행하세요.';

const WIPE_TARGETS = new Set(['/', '/*', '~', '~/', '~/*', '$HOME', '$HOME/', '$HOME/*', '${HOME}', '*', '.', './', './*', '..', '../', '../*']);

/** 명령 안의 rm 마다 재귀+강제 플래그와 전체 삭제 대상을 함께 쓰는지 본다. */
function isWipe(cmd) {
  for (const seg of cmd.split(/;|&&|\|\||\||\n/)) {
    const tokens = seg.trim().split(/\s+/).map(t => t.replace(/^["']|["']$/g, ''));
    const i = tokens.findIndex(t => t === 'rm' || t.endsWith('/rm'));
    if (i < 0) continue;
    let recursive = false, force = false, endOfFlags = false;
    const targets = [];
    for (const t of tokens.slice(i + 1)) {
      if (!endOfFlags && t === '--') { endOfFlags = true; continue; }
      if (!endOfFlags && t.startsWith('--')) {
        if (t === '--recursive') recursive = true;
        if (t === '--force') force = true;
        continue;
      }
      if (!endOfFlags && t.startsWith('-') && t.length > 1) {
        if (/[rR]/.test(t)) recursive = true;
        if (/f/.test(t)) force = true;
        continue;
      }
      targets.push(t);
    }
    if (recursive && force && targets.some(t => WIPE_TARGETS.has(t))) return true;
  }
  return false;
}

const DENY = [
  {
    test: isWipe,
    reason: '루트·홈·현재 폴더 전체를 지우는 rm -rf 는 차단합니다. 지울 경로를 구체적으로 지정하세요.',
  },
  { test: cmd => gitCommands(cmd).some(g => g.sub === 'push' && isForcePush(parsePush(g.args))), reason: FORCE_PUSH_REASON },
  { re: /\bmkfs(\.\w+)?\b|\bdd\s+[^;&|]*\bof=\/dev\//, reason: '디스크를 덮어쓰는 명령은 차단합니다.' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb 은 차단합니다.' },
];

const ASK = [
  { git: g => g.sub === 'reset' && g.args.includes('--hard'), reason: 'reset --hard 는 커밋하지 않은 변경을 버립니다.' },
  { git: g => g.sub === 'clean' && (g.args.includes('--force') || hasShort(g.args, 'f')), reason: 'git clean -f 는 추적하지 않는 파일을 지웁니다.' },
  { git: g => (g.sub === 'checkout' || g.sub === 'restore') && g.args.some(a => a === '.' || a === './'), reason: '작업 트리 전체의 변경을 되돌립니다.' },
  {
    git: g => g.sub === 'branch' && (hasShort(g.args, 'D')
      || ((g.args.includes('--delete') || hasShort(g.args, 'd')) && (g.args.includes('--force') || hasShort(g.args, 'f')))),
    reason: '병합되지 않은 브랜치를 강제로 지웁니다.',
  },
  { re: /\bdropDatabase\s*\(|\.drop\s*\(\s*\)|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?\w/i, reason: '데이터를 지우는 DB 명령입니다.' },
  { re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: '내려받은 스크립트를 바로 실행합니다.' },
  { re: /\bnpm\s+publish\b|\bgh\s+pr\s+merge\b|\bgh\s+release\s+create\b/, reason: '외부에 공개·병합하는 명령입니다.' },
];

/** 보호 브랜치로의 직접 푸시, 또는 전체 푸시(--all/--mirror)인지. 해당하면 이유 문자열. */
function protectedPushReason(cmd, branches, currentBranch) {
  for (const g of gitCommands(cmd)) {
    if (g.sub !== 'push') continue;
    const push = parsePush(g.args);
    if (push.flags.includes('--all') || push.flags.includes('--mirror')) return '모든 브랜치를 한꺼번에 푸시합니다 (--all/--mirror).';
    // --tags 만 있고 리프스펙이 없으면 브랜치는 푸시하지 않는다
    if (push.refspecs.length === 0 && push.flags.includes('--tags')) continue;
    const hit = pushTargets(push, currentBranch).find(b => branches.includes(b));
    if (hit) return `보호 브랜치(${hit})로 직접 푸시합니다.`;
  }
  return null;
}

function compile(patterns) {
  return patterns.map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean);
}

/**
 * @param {string} command
 * @param {{protectedBranches: string[], deny: string[], ask: string[], currentBranch?: string}} guard
 *   currentBranch: 리프스펙 없는 git push 의 대상 판단용. 호출자(guard.mjs)가 조회해 넘긴다.
 */
export function checkCommand(command, guard = { protectedBranches: ['main', 'master'], deny: [], ask: [] }) {
  const cmd = String(command || '');
  if (!cmd.trim()) return { decision: 'allow' };

  for (const re of compile(guard.deny)) if (re.test(cmd)) return { decision: 'deny', reason: `레포 설정(.harness.json guard.deny)이 막는 명령입니다: /${re.source}/` };
  for (const r of DENY) if (r.test ? r.test(cmd) : r.re.test(cmd)) return { decision: 'deny', reason: r.reason };

  const pushReason = protectedPushReason(cmd, guard.protectedBranches || [], guard.currentBranch);
  if (pushReason) return { decision: 'ask', reason: pushReason };

  for (const re of compile(guard.ask)) if (re.test(cmd)) return { decision: 'ask', reason: `레포 설정(.harness.json guard.ask)이 확인을 요구하는 명령입니다: /${re.source}/` };
  const gits = gitCommands(cmd);
  for (const r of ASK) if (r.git ? gits.some(r.git) : r.re.test(cmd)) return { decision: 'ask', reason: r.reason };

  return { decision: 'allow' };
}

/**
 * 플랫폼이 지원하는 결정으로 바꾼다. Codex PreToolUse 는 'ask' 를 지원하지 않으므로
 * 실행을 막고, 사용자에게 직접 실행할지 물어보라고 안내한다.
 */
export function toPlatformVerdict(verdict, platform) {
  if (platform === 'codex' && verdict.decision === 'ask') {
    return { decision: 'deny', reason: `확인이 필요한 명령이라 실행하지 않았습니다 (${verdict.reason}). 사용자에게 이 명령을 직접 실행할지 물어보세요.` };
  }
  return verdict;
}

/** git commit 명령인지 (커밋 전 게이트 대상). */
export function isCommit(command) {
  return gitCommands(command).some(g => g.sub === 'commit' && !g.args.includes('--dry-run'));
}
