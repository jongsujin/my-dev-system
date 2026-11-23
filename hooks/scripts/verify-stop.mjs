#!/usr/bin/env node
// Stop: 응답을 끝내기 전에 검증 명령을 돌린다.
// 바뀐 코드 파일이 있고 .harness.json verify.onStop 이 있을 때만 동작.
// 같은 세션에서 연속 MAX_BLOCKS 번 막았으면 사용자에게 넘긴다 (무한 루프 방지).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { changedFiles, emit, loadConfig, projectRoot, readInput, resolveCommands, run, skipped } from './lib.mjs';

const MAX_BLOCKS = 3;

if (skipped()) process.exit(0);
const input = await readInput();
const root = projectRoot(input.cwd);
const config = loadConfig(root);
if (!config || config.verify.onStop.length === 0) process.exit(0);

const exts = new Set(config.verify.onEditExtensions);
const changed = changedFiles(root).filter(f => exts.has(extname(f)));
if (changed.length === 0) process.exit(0);

const dir = join(tmpdir(), 'my-harness');
const counterFile = join(dir, `stop-${String(input.session_id || 'na').replace(/[^\w-]/g, '')}.json`);
const count = existsSync(counterFile) ? JSON.parse(readFileSync(counterFile, 'utf8')).count || 0 : 0;

const failures = [];
for (const { name, cmd } of resolveCommands(config.verify.onStop, config.verify.commands)) {
  const r = run(cmd, root);
  if (!r.ok) failures.push(`■ ${name} (\`${cmd}\`)\n${r.out}`);
}

mkdirSync(dir, { recursive: true });
if (failures.length === 0) {
  writeFileSync(counterFile, JSON.stringify({ count: 0 }));
  process.exit(0);
}

const report = `[harness] 완료 전 검증 실패 (바뀐 코드 파일 ${changed.length}개)\n\n${failures.join('\n\n')}`;
if (!config.gates.block || count >= MAX_BLOCKS) {
  writeFileSync(counterFile, JSON.stringify({ count: 0 }));
  emit({ systemMessage: `${report}\n\n(${count >= MAX_BLOCKS ? `${MAX_BLOCKS}번 연속 실패해 사용자에게 넘깁니다` : '안내 모드'})` });
  process.exit(0);
}
writeFileSync(counterFile, JSON.stringify({ count: count + 1 }));
emit({ decision: 'block', reason: `${report}\n\n끝내기 전에 위 실패를 고치고, 원래부터 실패하던 것이면 그 근거를 보고하세요.` });
process.exit(0);
