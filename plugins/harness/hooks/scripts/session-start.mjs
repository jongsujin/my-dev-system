#!/usr/bin/env node
// SessionStart: 공용 규칙 + 레포가 고른 스택 규칙 + 레포 작업 노트 상위 N개를 주입한다.
// 주입량은 MAX_CHARS 로 제한한다 (컨텍스트를 아끼기 위해).
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG_FILE, PLUGIN_ROOT, baselinePath, changedFiles, emit, fileHashes, loadConfigState, projectRoot, readInput, unknownCommandNames, writeJson } from './lib.mjs';
import { topLessons } from './lessons.mjs';

const MAX_CHARS = 8000;

const input = await readInput();
const root = projectRoot(input.cwd);
const state = loadConfigState(root);
const config = state.status === 'ok' ? state.config : null;

// 완료 전 검증이 "세션 전부터 바뀌어 있던 파일" 때문에 매번 막지 않도록, 지금 바뀐 파일의 해시를 기준선으로 남긴다.
// 새 세션(startup/clear)에만 쓰고, resume/compact 는 기존 기준선을 유지한다.
// source 가 없으면(플랫폼 차이) 기준선이 없을 때만 쓴다. 실패해도 세션 시작은 막지 않는다.
try {
  const source = input.source;
  const p = baselinePath(input.session_id);
  const fresh = source === 'startup' || source === 'clear' || (!source && !existsSync(p));
  if (input.session_id && config && config.verify.onStop.length && fresh) {
    writeJson(p, { root, files: fileHashes(root, changedFiles(root)) });
  }
} catch { /* 기준선 없이도 동작한다 (전체 작업 트리 기준으로 돌아감) */ }

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
  if (top.length) parts.push('# 이 레포 작업 노트 (반복 횟수 순)', ...top.map(l => `- ${l.text} (×${l.count})`));
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
