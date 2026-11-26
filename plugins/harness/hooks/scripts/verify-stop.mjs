#!/usr/bin/env node
// Stop: 응답을 끝내기 전에 검증 명령을 돌린다.
// 이번 세션에서 바뀐 코드 파일이 있고 .harness.json verify.onStop 이 있을 때만 동작.
// "이번 세션" 은 SessionStart 가 남긴 기준선과 비교해 정한다. 기준선이 없으면 작업 트리 전체.
// 같은 세션에서 연속 MAX_BLOCKS 번 막았으면 사용자에게 넘긴다 (무한 루프 방지).
import { extname } from 'node:path';
import {
  STOP_HOOK_DEADLINE_MS, baselinePath, changedFiles, counterPath, emit, failureHead, fileHashes, loadConfig, projectRoot,
  readInput, readJson, resolveCommands, runWithin, sessionChanges, sha1, skipped, stopDecision, writeJson,
} from './lib.mjs';

const deadline = Date.now() + STOP_HOOK_DEADLINE_MS;

if (skipped()) process.exit(0);
const input = await readInput();
const root = projectRoot(input.cwd);
const config = loadConfig(root);
if (!config || config.verify.onStop.length === 0) process.exit(0);

const exts = new Set(config.verify.onEditExtensions);
const current = fileHashes(root, changedFiles(root).filter(f => exts.has(extname(f))));
const baseline = readJson(baselinePath(input.session_id));
// 다른 레포에서 같은 세션 id 로 남은 기준선은 쓰지 않는다
const baseFiles = baseline && baseline.root === root ? baseline.files : null;
const changed = sessionChanges(current, baseFiles);
if (changed.length === 0) process.exit(0);

const counterFile = counterPath(input.session_id);
const state = readJson(counterFile) || {};

const failures = [];
const failedNames = [];
for (const { name, cmd } of resolveCommands(config.verify.onStop, config.verify.commands)) {
  const r = runWithin(cmd, root, deadline, config.verify.timeoutSec * 1000);
  if (!r.ok) { failures.push(`${failureHead(name, cmd, r)}\n${r.out}`); failedNames.push(name); }
}

// 넘긴 뒤 아무것도 바뀌지 않았는지 알아보기 위한 서명: 대상 파일 해시 + 실패한 검사 이름
const signature = sha1(JSON.stringify([changed.sort().map(f => [f, current[f]]), failedNames]));
const { action, next } = stopDecision(state, { failed: failures.length > 0, block: config.gates.block, signature });
writeJson(counterFile, next);
if (action === 'pass') process.exit(0);

const report = `[harness] 완료 전 검증 실패 (이번 세션에서 바뀐 코드 파일 ${changed.length}개)\n\n${failures.join('\n\n')}`;
if (action === 'block') {
  emit({ decision: 'block', reason: `${report}\n\n끝내기 전에 위 실패를 고치고, 원래부터 실패하던 것이면 그 근거를 보고하세요.` });
} else {
  const note = { advisory: '안내 모드', handoff: '여러 번 연속 실패해 사용자에게 넘깁니다', repeat: '사용자에게 넘긴 뒤 바뀐 것이 없어 다시 막지 않습니다' }[action];
  emit({ systemMessage: `${report}\n\n(${note})` });
}
process.exit(0);
