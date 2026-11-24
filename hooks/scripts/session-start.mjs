#!/usr/bin/env node
// SessionStart: 공용 규칙 + 레포가 고른 스택 규칙 + 레포 교훈 상위 N개를 주입한다.
// 주입량은 MAX_CHARS 로 제한한다 (컨텍스트를 아끼기 위해).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, PLUGIN_ROOT, emit, loadConfigState, projectRoot, readInput, unknownCommandNames } from './lib.mjs';
import { topLessons } from './lessons.mjs';

const MAX_CHARS = 8000;

const input = await readInput();
const root = projectRoot(input.cwd);
const state = loadConfigState(root);
const config = state.status === 'ok' ? state.config : null;

function readRules(set) {
  const dir = join(PLUGIN_ROOT, 'rules', set);
  if (!existsSync(dir)) return '';
  return readdirSync(dir).filter(f => f.endsWith('.md')).sort()
    .map(f => readFileSync(join(dir, f), 'utf8').trim()).join('\n\n');
}

const sets = config ? [...new Set(['common', ...config.context.rules])] : ['common'];
const parts = [`# 하네스 규칙 (${sets.join(', ')})`, ...sets.map(readRules).filter(Boolean)];

const lessonsPath = join(root, '.harness', 'lessons.md');
if (existsSync(lessonsPath)) {
  const top = topLessons(readFileSync(lessonsPath, 'utf8'), config?.context.maxLessons ?? 6);
  if (top.length) parts.push('# 이 레포에서 배운 교훈 (반복 횟수 순)', ...top.map(l => `- ${l.text} (×${l.count})`));
}

function statusSection() {
  if (state.status === 'broken') {
    return `# 하네스 상태\n${CONFIG_FILE} 이 깨져 있어 읽지 못했습니다 (${state.error}). 편집·완료·커밋 검증 게이트는 모두 꺼져 있고 위험 명령 차단만 기본값으로 동작합니다. 사용자에게 이 사실을 알리고 파일을 고치자고 제안하세요.`;
  }
  if (!config) {
    return `# 하네스 상태\n이 레포에는 ${CONFIG_FILE} 이 없어 위험 명령 차단만 동작합니다. 기존 프로젝트면 harness:onboard, 새 프로젝트면 harness:new-project 스킬로 만들 수 있다고 사용자에게 한 번 안내하세요.`;
  }
  const lines = [`# 하네스 상태\n${CONFIG_FILE} 활성: 편집 직후 검사 ${config.verify.onEdit ? '켜짐' : '꺼짐'}, 완료 전 검증 [${config.verify.onStop.join(', ') || '없음'}], 커밋 전 검증 [${config.verify.onCommit.join(', ') || '없음'}], 모드 ${config.gates.block ? '차단' : '안내'}.`];
  // 없는 이름은 조용히 빠져 게이트가 비므로 눈에 띄게 알린다
  const unknown = unknownCommandNames(config.verify);
  for (const [key, list] of Object.entries(unknown)) {
    if (list.length) lines.push(`경고: verify.${key} 의 [${list.join(', ')}] 는 verify.commands 에 없어 실행되지 않습니다. 사용자에게 알리세요.`);
  }
  return lines.join('\n');
}
parts.push(statusSection());

let text = parts.join('\n\n');
if (text.length > MAX_CHARS) text = `${text.slice(0, MAX_CHARS)}\n…(주입 상한 ${MAX_CHARS}자에서 잘림)`;

emit({ hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: text } });
