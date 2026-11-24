#!/usr/bin/env node
// PostToolUse(Edit|Write|MultiEdit): 방금 고친 파일만 검사한다.
// .harness.json 의 verify.onEdit 가 있을 때만 동작. {file} 자리에 파일 경로가 들어간다.
import { extname, relative } from 'node:path';
import { emit, fileCommand, loadConfig, projectRoot, readInput, run, skipped } from './lib.mjs';

if (skipped()) process.exit(0);
const input = await readInput();
const file = input?.tool_input?.file_path;
if (!file) process.exit(0);

const root = projectRoot(input.cwd);
const config = loadConfig(root);
if (!config?.verify.onEdit) process.exit(0);
if (!config.verify.onEditExtensions.includes(extname(file))) process.exit(0);

const rel = relative(root, file);
if (rel.startsWith('..')) process.exit(0);

const cmd = fileCommand(config.verify.onEdit);
const r = run(cmd, root, 60_000, { HARNESS_FILE: rel });
if (!r.ok) {
  emit({ decision: 'block', reason: `[harness] ${rel} 검사 실패 (\`${config.verify.onEdit}\`)${r.timedOut ? ' — 60초 안에 끝나지 않음' : ''}\n${r.out}\n\n이 파일의 문제를 지금 고치세요.` });
}
process.exit(0);
