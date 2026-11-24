import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLessons, promotionCandidates, topLessons } from '../hooks/scripts/lessons.mjs';
import { MAX_BLOCKS, MIN_COMMAND_MS, failureHead, normalizeConfig, runWithin, resolveCommands, sessionChanges, stopDecision, unknownCommandNames } from '../hooks/scripts/lib.mjs';

const MD = `# 교훈
- [×3] 커밋 메시지는 한글로 <!-- level:rule updated:2026-11-01 -->
- [×1] dev 서버는 3001 포트 <!-- level:memo -->
- [×2] 결제 테스트 키도 실제 출금될 수 있음
- [×5] 운영 DB 직접 접속 금지 <!-- level:hook -->
아무 문장
`;

test('교훈 파싱', () => {
  const ls = parseLessons(MD);
  assert.equal(ls.length, 4);
  assert.deepEqual(ls[0], { count: 3, text: '커밋 메시지는 한글로', level: 'rule', updated: '2026-11-01' });
  assert.equal(ls[2].level, 'memo');
});

test('주입 대상은 훅 단계 제외, 횟수 순', () => {
  assert.deepEqual(topLessons(MD, 2).map(l => l.count), [3, 2]);
  assert.equal(topLessons(MD, 0).length, 0);
});

test('승격 후보', () => {
  const c = promotionCandidates(MD);
  assert.deepEqual(c.map(x => [x.text, x.to]), [['커밋 메시지는 한글로', 'hook'], ['결제 테스트 키도 실제 출금될 수 있음', 'rule']]);
});

test('설정 기본값', () => {
  const c = normalizeConfig({});
  assert.equal(c.gates.block, true);
  assert.deepEqual(c.guard.protectedBranches, ['main', 'master']);
  assert.deepEqual(c.review.reviewers, ['security', 'quality', 'backend', 'frontend', 'convention', 'test']);
  assert.equal(normalizeConfig({ gates: { block: false } }).gates.block, false);
  assert.equal(normalizeConfig({ context: { maxLessons: 0 } }).context.maxLessons, 0);
});

test('명령 이름 해석: 없는 이름은 건너뜀', () => {
  assert.deepEqual(resolveCommands(['lint', 'nope', 'test'], { lint: 'npm run lint', test: ' ' }), [{ name: 'lint', cmd: 'npm run lint' }]);
});

test('잘못된 형식도 던지지 않는다', () => {
  const c = normalizeConfig({ verify: { onStop: 'lint', onCommit: 3, commands: [] } });
  assert.deepEqual(c.verify.onStop, ['lint']);
  assert.deepEqual(c.verify.onCommit, []);
  assert.deepEqual(c.verify.commands, {});
  assert.deepEqual(resolveCommands('lint', { lint: 'x' }), []);
});

test('정의되지 않은 명령 이름', () => {
  const verify = { commands: { lint: 'npm run lint', empty: ' ' }, onStop: ['lint', 'typechek'], onCommit: ['empty', 'lint'] };
  assert.deepEqual(unknownCommandNames(verify), { onStop: ['typechek'], onCommit: ['empty'] });
  assert.deepEqual(unknownCommandNames({ onStop: 'x' }), { onStop: ['x'], onCommit: [] });
  assert.deepEqual(unknownCommandNames(undefined), { onStop: [], onCommit: [] });
});

test('세션 변경 파일: 기준선과 비교', () => {
  const cur = { 'a.ts': 'h1', 'b.ts': 'h2', 'c.ts': 'deleted' };
  assert.deepEqual(sessionChanges(cur, null), ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(sessionChanges(cur, { 'a.ts': 'h1', 'b.ts': 'old', 'c.ts': 'deleted' }), ['b.ts']);
  assert.deepEqual(sessionChanges(cur, {}), ['a.ts', 'b.ts', 'c.ts']);
  assert.deepEqual(sessionChanges({}, { 'a.ts': 'h1' }), []);
});

test('Stop 결정: 3번 막고 넘긴 뒤 바뀐 게 없으면 다시 막지 않음', () => {
  let state = {};
  const step = (sig, failed = true, block = true) => { const r = stopDecision(state, { failed, block, signature: sig }); state = r.next; return r.action; };
  for (let i = 0; i < MAX_BLOCKS; i++) assert.equal(step('s1'), 'block');
  assert.equal(step('s1'), 'handoff');
  assert.equal(step('s1'), 'repeat');
  assert.equal(step('s1'), 'repeat');
  assert.equal(step('s2'), 'block');
  assert.equal(step('s2', false), 'pass');
  assert.equal(step('s3', true, false), 'advisory');
});

test('시간 한도: 기본값과 남은 시간 부족', () => {
  assert.equal(normalizeConfig({}).verify.timeoutSec, 180);
  assert.equal(normalizeConfig({ verify: { timeoutSec: 30 } }).verify.timeoutSec, 30);
  assert.equal(normalizeConfig({ verify: { timeoutSec: '30' } }).verify.timeoutSec, 180);
  const now = 1_000_000;
  const r = runWithin('true', '.', now + MIN_COMMAND_MS - 1, 180_000, now);
  assert.equal(r.notRun, true);
  assert.equal(r.ok, false);
  assert.match(failureHead('lint', 'npm run lint', r), /실행하지 않음/);
  assert.match(failureHead('lint', 'x', { timedOut: true, limitMs: 2000 }), /2초 안에 끝나지 않음/);
});
