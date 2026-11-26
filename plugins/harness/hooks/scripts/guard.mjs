#!/usr/bin/env node
// PreToolUse(Bash): 위험 명령 차단 + 커밋 전 검증 게이트.
// 차단 판단은 .harness.json 이 없어도 항상 동작한다. 커밋 게이트는 설정이 있을 때만.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { checkCommand, isCommit, pushDir, toPlatformVerdict } from './guard-rules.mjs';
import { COMMIT_HOOK_DEADLINE_MS, PLATFORM, emit, failureHead, loadConfig, normalizeConfig, projectRoot, readInput, resolveCommands, runWithin, skipped } from './lib.mjs';

const deadline = Date.now() + COMMIT_HOOK_DEADLINE_MS;

const input = await readInput();
const raw = input?.tool_input?.command;
const command = Array.isArray(raw) ? raw.join(' ') : raw;
if (!command) process.exit(0);

const root = projectRoot(input.cwd);
const config = loadConfig(root);
const guard = { ...(config || normalizeConfig()).guard };

// 리프스펙 없는 git push 는 현재 브랜치로 판단해야 해서, push 가 있을 때만 git 을 부른다.
const dir = pushDir(command);
if (dir !== undefined) {
  const r = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: resolve(input.cwd || process.cwd(), dir || '.'), encoding: 'utf8' });
  if (r.status === 0) guard.currentBranch = r.stdout.trim();
}

const verdict = toPlatformVerdict(checkCommand(command, guard), PLATFORM);
if (verdict.decision !== 'allow') {
  emit({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: verdict.decision,
      permissionDecisionReason: `[harness guard] ${verdict.reason}`,
    },
  });
  process.exit(0);
}

if (config && !skipped() && isCommit(command)) {
  for (const { name, cmd } of resolveCommands(config.verify.onCommit, config.verify.commands)) {
    const r = runWithin(cmd, root, deadline, config.verify.timeoutSec * 1000);
    if (!r.ok) {
      const reason = `[harness] 커밋 전 검증 실패\n${failureHead(name, cmd, r)}\n${r.out}\n\n고친 뒤 다시 커밋하세요.`;
      if (config.gates.block) {
        emit({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });
      } else {
        emit({ systemMessage: reason });
      }
      process.exit(0);
    }
  }
}
process.exit(0);
