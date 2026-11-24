// 실제 훅 스크립트를 임시 git 레포에 대고 stdin JSON 으로 실행하는 통합 테스트.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileCommand } from '../hooks/scripts/lib.mjs';

const SCRIPTS = new URL('../hooks/scripts/', import.meta.url).pathname;
const cleanup = [];
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
