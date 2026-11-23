// 위험 명령 판단. 순수 함수만 둔다 (tests/guard.test.mjs).
//
// 결과: { decision: 'allow' | 'ask' | 'deny', reason?: string }
//  - deny: 실행 자체를 막는다. 되돌릴 수 없고 의도적일 가능성이 낮은 명령.
//  - ask : 사용자에게 확인을 받는다. 정당한 쓰임도 있는 명령.

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
  { re: /\bgit\s+push\b(?=[^;&|]*\s(?:--force(?!-with-lease)|-f)(?:\s|$))/, reason: '강제 푸시는 차단합니다. 꼭 필요하면 --force-with-lease 로, 사용자 확인 후 직접 실행하세요.' },
  { re: /\bmkfs(\.\w+)?\b|\bdd\s+[^;&|]*\bof=\/dev\//, reason: '디스크를 덮어쓰는 명령은 차단합니다.' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\};:/, reason: 'fork bomb 은 차단합니다.' },
];

const ASK = [
  { re: /\bgit\s+reset\s+--hard\b/, reason: 'reset --hard 는 커밋하지 않은 변경을 버립니다.' },
  { re: /\bgit\s+clean\s+-[a-zA-Z]*f/, reason: 'git clean -f 는 추적하지 않는 파일을 지웁니다.' },
  { re: /\bgit\s+checkout\s+(?:--\s+)?\.(?:\s|$)|\bgit\s+restore\s+(?:--\S+\s+)*\.(?:\s|$)/, reason: '작업 트리 전체의 변경을 되돌립니다.' },
  { re: /\bgit\s+branch\s+-D\b/, reason: '병합되지 않은 브랜치를 강제로 지웁니다.' },
  { re: /\bdropDatabase\s*\(|\.drop\s*\(\s*\)|\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b|\bTRUNCATE\s+(?:TABLE\s+)?\w/i, reason: '데이터를 지우는 DB 명령입니다.' },
  { re: /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z)?sh\b/, reason: '내려받은 스크립트를 바로 실행합니다.' },
  { re: /\bnpm\s+publish\b|\bgh\s+pr\s+merge\b|\bgh\s+release\s+create\b/, reason: '외부에 공개·병합하는 명령입니다.' },
];

/** 보호 브랜치로의 직접 푸시인지. */
function pushToProtected(cmd, branches) {
  const m = cmd.match(/\bgit\s+push\b([^;&|]*)/);
  if (!m) return null;
  const args = m[1].split(/\s+/).filter(a => a && !a.startsWith('-'));
  // git push <remote> <refspec...>
  for (const ref of args.slice(1)) {
    const dst = ref.includes(':') ? ref.split(':').pop() : ref;
    const name = dst.replace(/^refs\/heads\//, '').replace(/^\+/, '');
    if (branches.includes(name)) return name;
  }
  return null;
}

function compile(patterns) {
  return patterns.map(p => { try { return new RegExp(p); } catch { return null; } }).filter(Boolean);
}

/**
 * @param {string} command
 * @param {{protectedBranches: string[], deny: string[], ask: string[]}} guard
 */
export function checkCommand(command, guard = { protectedBranches: ['main', 'master'], deny: [], ask: [] }) {
  const cmd = String(command || '');
  if (!cmd.trim()) return { decision: 'allow' };

  for (const re of compile(guard.deny)) if (re.test(cmd)) return { decision: 'deny', reason: `레포 설정(.harness.json guard.deny)이 막는 명령입니다: /${re.source}/` };
  for (const r of DENY) if (r.test ? r.test(cmd) : r.re.test(cmd)) return { decision: 'deny', reason: r.reason };

  const branch = pushToProtected(cmd, guard.protectedBranches);
  if (branch) return { decision: 'ask', reason: `보호 브랜치(${branch})로 직접 푸시합니다.` };

  for (const re of compile(guard.ask)) if (re.test(cmd)) return { decision: 'ask', reason: `레포 설정(.harness.json guard.ask)이 확인을 요구하는 명령입니다: /${re.source}/` };
  for (const r of ASK) if (r.re.test(cmd)) return { decision: 'ask', reason: r.reason };

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
  return /(?:^|[;&|]\s*|\s)git\s+(?:-c\s+\S+\s+)*commit\b/.test(String(command || '')) && !/--dry-run/.test(command);
}
