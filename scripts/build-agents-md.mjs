#!/usr/bin/env node
// Claude Code 이외 플랫폼(Codex, Antigravity, Cursor 등)용 내보내기.
// rules/ 를 합쳐 dist/AGENTS.md 하나로 만든다. 스킬 폴더는 SKILL.md 형식이 같아 링크로 공유한다.
//
//   node scripts/build-agents-md.mjs [typescript react ...]
//
// 결과물을 대상 레포의 AGENTS.md 에 붙이거나, 개인 전역 지침 파일로 쓴다.
// 플랫폼별 전역 경로는 버전마다 다르므로 각 공식 문서를 확인할 것.
import { mkdirSync, readdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sets = ['common', ...process.argv.slice(2).filter(s => s !== 'common')];

const sections = sets.map(set => {
  const dir = join(root, 'plugins/harness/rules', set);
  if (!existsSync(dir)) { console.error(`rules/${set} 없음 — 건너뜀`); return ''; }
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    .map(f => readFileSync(join(dir, f), 'utf8').trim().replace(/^# /gm, '## ')).join('\n\n');
}).filter(Boolean);

const out = `# 공용 에이전트 지침 (my-harness: ${sets.join(', ')})\n\n> 생성 파일. 원본은 plugins/harness/rules/ 에서 고친다.\n\n${sections.join('\n\n')}\n`;
mkdirSync(join(root, 'dist'), { recursive: true });
writeFileSync(join(root, 'dist', 'AGENTS.md'), out);
console.log(`dist/AGENTS.md (${out.length}자, 규칙 세트: ${sets.join(', ')})`);
