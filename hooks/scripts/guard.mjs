#!/usr/bin/env node
// PreToolUse(Bash): 위험 명령 차단 + 커밋 전 검증 게이트.
// 차단 판단은 .harness.json 이 없어도 항상 동작한다. 커밋 게이트는 설정이 있을 때만.
import { checkCommand, isCommit } from './guard-rules.mjs';
import { emit, loadConfig, normalizeConfig, projectRoot, readInput, resolveCommands, run, skipped } from './lib.mjs';

const input = await readInput();
const command = input?.tool_input?.command;
if (!command) process.exit(0);

const root = projectRoot(input.cwd);
const config = loadConfig(root);
const guard = (config || normalizeConfig()).guard;

const verdict = checkCommand(command, guard);
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
    const r = run(cmd, root);
    if (!r.ok) {
      const reason = `[harness] 커밋 전 검증 실패: ${name} (\`${cmd}\`)\n${r.out}\n\n고친 뒤 다시 커밋하세요.`;
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
