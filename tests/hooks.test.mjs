// 실제 훅 스크립트를 임시 git 레포에 대고 stdin JSON 으로 실행하는 통합 테스트.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { baselinePath, counterPath, fileCommand } from '../hooks/scripts/lib.mjs';

const SCRIPTS = new URL('../hooks/scripts/', import.meta.url).pathname;
const cleanup = [];
/** 세션 id 마다 tmpdir 의 기준선·카운터 파일도 지운다. */
export function sid(name) {
  const id = `test-${process.pid}-${name}`;
  cleanup.push(baselinePath(id), counterPath(id));
  return id;
}
after(() => { for (const p of cleanup) rmSync(p, { recursive: true, force: true }); });

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=test', '-c', 'user.email=test@example.invalid', ...args], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

/** 빈 첫 커밋이 있는 임시 레포. config 가 있으면 .harness.json 으로 쓰고 커밋한다. */
export function makeRepo(config) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-test-')));
  cleanup.push(dir);
  git(dir, 'init', '-q', '-b', 'main');
  if (config !== undefined) writeFileSync(join(dir, '.harness.json'), typeof config === 'string' ? config : JSON.stringify(config));
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  return dir;
}

export function hook(script, input, env = {}) {
  const r = spawnSync(process.execPath, [join(SCRIPTS, script)], {
    input: JSON.stringify(input), encoding: 'utf8',
    env: { ...process.env, HARNESS_SKIP: '', HARNESS_PLATFORM: '', ...env },
  });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout ? JSON.parse(r.stdout) : null;
}

test('fileCommand: {file} 은 환경 변수 참조로', () => {
  assert.equal(fileCommand('npx --no-install eslint {file}'), 'npx --no-install eslint "$HARNESS_FILE"');
  assert.equal(fileCommand('eslint "{file}"'), 'eslint "$HARNESS_FILE"');
  assert.equal(fileCommand("eslint '{file}'"), 'eslint "$HARNESS_FILE"');
});

test('onEdit: 파일 이름의 명령 치환은 실행되지 않는다', () => {
  const dir = makeRepo({ verify: { onEdit: 'test -f {file}' } });
  const name = 'a$(touch PWNED).ts';
  writeFileSync(join(dir, name), '');
  const out = hook('lint-edited.mjs', { cwd: dir, tool_input: { file_path: join(dir, name) } });
  assert.equal(out, null, '파일 경로가 그대로 전달돼 test -f 가 통과해야 한다');
  assert.equal(existsSync(join(dir, 'PWNED')), false);
});

test('onEdit: 따옴표로 감싼 {file} 도 동작', () => {
  for (const tpl of ['test -f "{file}"', "test -f '{file}'"]) {
    const dir = makeRepo({ verify: { onEdit: tpl } });
    writeFileSync(join(dir, 'b c.ts'), '');
    assert.equal(hook('lint-edited.mjs', { cwd: dir, tool_input: { file_path: join(dir, 'b c.ts') } }), null, tpl);
    const fail = hook('lint-edited.mjs', { cwd: dir, tool_input: { file_path: join(dir, 'missing.ts') } });
    assert.equal(fail.decision, 'block', tpl);
  }
});

test('SessionStart: 깨진 설정은 깨졌다고, 없는 이름은 경고로', () => {
  const broken = makeRepo('{ "verify": ');
  const a = hook('session-start.mjs', { cwd: broken, session_id: 'e-broken', source: 'startup' }).hookSpecificOutput.additionalContext;
  assert.match(a, /깨져 있어/);
  assert.match(a, /JSON/);
  assert.match(a, /게이트는 모두 꺼져/);
  assert.doesNotMatch(a, /이 없어 위험 명령 차단만/);

  const typo = makeRepo({ verify: { commands: { typecheck: 'true' }, onCommit: ['typechek'] } });
  const b = hook('session-start.mjs', { cwd: typo, session_id: 'e-typo', source: 'startup' }).hookSpecificOutput.additionalContext;
  assert.match(b, /verify\.onCommit 의 \[typechek\]/);
});

const STOP_CONFIG = { verify: { commands: { check: 'test ! -f FAIL' }, onStop: ['check'] } };

test('Stop: 기준선 이전부터 바뀐 파일은 무시하고, 세션 중 바뀐 파일에만 반응', () => {
  const dir = makeRepo(STOP_CONFIG);
  const id = sid('baseline');
  writeFileSync(join(dir, 'old.ts'), 'dirty before');
  writeFileSync(join(dir, 'FAIL'), '');
  hook('session-start.mjs', { cwd: dir, session_id: id, source: 'startup' });
  assert.equal(hook('verify-stop.mjs', { cwd: dir, session_id: id }), null, '세션 전부터 더러운 파일만 있으면 통과');

  writeFileSync(join(dir, 'old.ts'), 'edited in session');
  assert.equal(hook('verify-stop.mjs', { cwd: dir, session_id: id }).decision, 'block');

  // resume 은 기준선을 다시 만들지 않는다
  hook('session-start.mjs', { cwd: dir, session_id: id, source: 'resume' });
  assert.equal(hook('verify-stop.mjs', { cwd: dir, session_id: id }).decision, 'block');
});

test('Stop: 기준선이 없으면 작업 트리 전체 기준', () => {
  const dir = makeRepo(STOP_CONFIG);
  writeFileSync(join(dir, 'old.ts'), 'x');
  writeFileSync(join(dir, 'FAIL'), '');
  assert.equal(hook('verify-stop.mjs', { cwd: dir, session_id: sid('nobase') }).decision, 'block');
});

test('Stop: 3번 막은 뒤 넘기고, 바뀐 게 없으면 다시 막지 않음', () => {
  const dir = makeRepo(STOP_CONFIG);
  const id = sid('handoff');
  writeFileSync(join(dir, 'FAIL'), '');
  hook('session-start.mjs', { cwd: dir, session_id: id, source: 'startup' });
  writeFileSync(join(dir, 'a.ts'), '1');
  const stop = () => hook('verify-stop.mjs', { cwd: dir, session_id: id });
  for (let i = 0; i < 3; i++) assert.equal(stop().decision, 'block');
  assert.match(stop().systemMessage, /사용자에게 넘깁니다/);
  const again = stop();
  assert.equal(again.decision, undefined);
  assert.match(again.systemMessage, /다시 막지 않습니다/);
  writeFileSync(join(dir, 'a.ts'), '2');
  assert.equal(stop().decision, 'block');
});
