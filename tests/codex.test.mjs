import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { BEGIN, END, configBlock, toCodexRole, upsertBlock } from '../scripts/codex-agents.mjs';
import { toPlatformVerdict } from '../plugins/harness/hooks/scripts/guard-rules.mjs';

const md = readFileSync(new URL('../plugins/harness/agents/reviewer-security.md', import.meta.url), 'utf8');

test('에이전트 → Codex 역할', () => {
  const r = toCodexRole(md);
  assert.equal(r.name, 'harness_reviewer_security');
  assert.equal(r.file, 'harness-reviewer-security.toml');
  assert.match(r.toml, /sandbox_mode = "read-only"/);
  assert.match(r.toml, /developer_instructions = '''\n당신은 보안 리뷰어/);
  assert.doesNotMatch(r.toml, /^model\s*=/m);
});

test('reviewer-backend 도 Codex 역할로 변환', () => {
  const r = toCodexRole(readFileSync(new URL('../plugins/harness/agents/reviewer-backend.md', import.meta.url), 'utf8'));
  assert.equal(r.name, 'harness_reviewer_backend');
  assert.equal(r.file, 'harness-reviewer-backend.toml');
  assert.match(r.toml, /sandbox_mode = "read-only"/);
  assert.match(r.toml, /당신은 백엔드 설계 리뷰어/);
});

test('config.toml 블록은 교체·제거가 멱등', () => {
  const base = 'model = "x"\n\n[features]\na = true\n';
  const block = configBlock([toCodexRole(md)]);
  const once = upsertBlock(base, block);
  const twice = upsertBlock(once, block);
  assert.equal(once, twice);
  assert.equal(once.split(BEGIN).length, 2);
  assert.match(once, /\[agents\.harness_reviewer_security\]\ndescription = ".+"\nconfig_file = "agents\/harness-reviewer-security\.toml"/);
  assert.ok(once.includes(END));
  assert.equal(upsertBlock(once, null), base);
});

test('Codex 에서는 ask 를 deny 로', () => {
  assert.equal(toPlatformVerdict({ decision: 'ask', reason: 'x' }, 'codex').decision, 'deny');
  assert.equal(toPlatformVerdict({ decision: 'ask', reason: 'x' }, 'claude').decision, 'ask');
  assert.equal(toPlatformVerdict({ decision: 'allow' }, 'codex').decision, 'allow');
});
