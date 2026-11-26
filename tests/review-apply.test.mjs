// apply 스킬의 사전 점검 스크립트: 임시 레포에 리포트와 파일을 두고 분류 결과를 확인한다.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { STATUSES, buildPlan, globToRegExp, matchesAny, DEFAULT_PROTECT } from '../plugins/harness/skills/apply/scripts/apply-plan.mjs';

const SCRIPT = new URL('../plugins/harness/skills/apply/scripts/apply-plan.mjs', import.meta.url).pathname;
const cleanup = [];
after(() => { for (const p of cleanup) rmSync(p, { recursive: true, force: true }); });

function git(cwd, ...args) {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
}

function makeDir(files = {}, { repo = false } = {}) {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'harness-apply-')));
  cleanup.push(dir);
  for (const [p, c] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    writeFileSync(join(dir, p), c);
  }
  if (repo) {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'test');
    git(dir, 'config', 'user.email', 'test@example.invalid');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'init');
  }
  return dir;
}

const finding = (over = {}) => ({
  id: 'F1', reviewers: ['security'], status: 'open', severity: 'critical', category: 'x',
  file: 'src/a.js', line: 2, title: '제목', evidence: 'const x = 1;', why: '이유', fix: '수정',
  verified: true, autoApplicable: true, ...over,
});

const report = (findings, over = {}) => ({ version: 1, branch: 'b', base: 'main', createdAt: '2026-11-25T10:00:00Z', findings, ...over });

function plan(files, findings, opts = {}, reportOver = {}) {
  const dir = makeDir(files);
  return buildPlan(dir, 'r.json', report(findings, reportOver), opts);
}
const item = (p, id = 'F1') => p.items.find(i => i.id === id);

function run(cwd, ...args) {
  return spawnSync(process.execPath, [SCRIPT, ...args], { cwd, encoding: 'utf8' });
}

test('glob: **/migrations/**, *.lock, 루트·중첩 package.json, 불일치', () => {
  assert.ok(matchesAny('db/migrations/001.sql', DEFAULT_PROTECT));
  assert.ok(matchesAny('migrations/001.sql', DEFAULT_PROTECT));
  assert.ok(matchesAny('Cargo.lock', DEFAULT_PROTECT));
  assert.ok(matchesAny('a/b/Gemfile.lock', DEFAULT_PROTECT));
  assert.ok(matchesAny('package.json', DEFAULT_PROTECT));
  assert.ok(matchesAny('apps/web/package.json', DEFAULT_PROTECT));
  assert.ok(!matchesAny('src/package.json.js', DEFAULT_PROTECT));
  assert.ok(!matchesAny('src/a.ts', DEFAULT_PROTECT));
  assert.ok(globToRegExp('src/*.ts').test('src/a.ts'));
  assert.ok(!globToRegExp('src/*.ts').test('src/x/a.ts'));
});

test('근거가 들여쓰기만 달라도 정확히 일치', () => {
  const p = plan({ 'src/a.js': 'function f() {\n    if (a) {\n      return b;\n    }\n}\n' },
    [finding({ evidence: 'if (a) {\nreturn b;', line: 2 })]);
  assert.deepEqual(item(p).locate, { status: 'exact', line: 2, endLine: 3 });
  assert.equal(item(p).bucket, 'auto');
});

test('여러 곳 일치는 line ±3 안에 하나면 exact, 아니면 ambiguous', () => {
  const text = 'x();\n'.repeat(1) + 'a\n'.repeat(10) + 'x();\n';
  const near = plan({ 'src/a.js': text }, [finding({ evidence: 'x();', line: 12 })]);
  assert.deepEqual(item(near).locate, { status: 'exact', line: 12, endLine: 12 });
  const far = plan({ 'src/a.js': text }, [finding({ evidence: 'x();', line: 6 })]);
  assert.deepEqual(item(far).locate, { status: 'ambiguous', candidates: [1, 12] });
  assert.equal(item(far).bucket, 'confirm');
});

test('근거가 바뀌었으면 drift 후보, 흔적이 없으면 gone', () => {
  const d = plan({ 'src/a.js': 'const totalAmount = 2;\n' }, [finding({ evidence: 'const totalAmount = 1;' })]);
  assert.equal(item(d).locate.status, 'drift');
  assert.deepEqual(item(d).locate.candidates, [{ line: 1, text: 'const totalAmount = 2;' }]);
  assert.equal(item(d).bucket, 'confirm');
  const g = plan({ 'src/a.js': 'nothing here\n' }, [finding({ evidence: 'const totalAmount = 1;' })]);
  assert.equal(item(g).locate.status, 'gone');
  assert.equal(item(g).bucket, 'blocked');
});

test('파일 없음·레포 밖 경로·절대 경로는 적용하지 않음', () => {
  const p = plan({}, [
    finding({ id: 'F1', file: 'src/none.js' }),
    finding({ id: 'F2', file: '../x.js' }),
    finding({ id: 'F3', file: '/etc/hosts' }),
  ]);
  assert.equal(item(p, 'F1').locate.status, 'missing-file');
  assert.equal(item(p, 'F2').locate.status, 'invalid-path');
  assert.equal(item(p, 'F3').locate.status, 'invalid-path');
  assert.ok(p.items.every(i => i.bucket === 'blocked'));
  assert.deepEqual(p.files, []);
});

test('보호 파일은 critical·autoApplicable 이어도 막음', () => {
  const p = plan({ 'package.json': '{ "a": 1 }\n' }, [finding({ file: 'package.json', evidence: '{ "a": 1 }' })]);
  assert.equal(item(p).locate.status, 'protected');
  assert.equal(item(p).bucket, 'blocked');
});

test('같은 파일에서 범위가 겹치면 서로 conflictsWith, 확인 후 적용으로', () => {
  const p = plan({ 'src/a.js': 'a();\nb();\nc();\n' }, [
    finding({ id: 'F1', evidence: 'a();\nb();' }),
    finding({ id: 'F2', evidence: 'b();\nc();' }),
    finding({ id: 'F3', evidence: 'c();' , file: 'src/a.js', line: 3 }),
  ]);
  assert.deepEqual(item(p, 'F1').conflictsWith, ['F2']);
  assert.deepEqual(item(p, 'F2').conflictsWith.sort(), ['F1', 'F3']);
  assert.ok(p.items.every(i => i.bucket === 'confirm'));
});

test('분류 규칙: critical 자동, major 는 --auto-major, autoApplicable 누락·verified false 는 자동 아님, minor 는 안내', () => {
  const files = { 'src/a.js': 'a();\nb();\nc();\nd();\ne();\n' };
  const fs = [
    finding({ id: 'F1', evidence: 'a();' }),
    finding({ id: 'F2', evidence: 'b();', severity: 'major' }),
    finding({ id: 'F3', evidence: 'c();', autoApplicable: undefined }),
    finding({ id: 'F4', evidence: 'd();', verified: false }),
    finding({ id: 'F5', evidence: 'e();', severity: 'minor' }),
  ];
  const p = plan(files, fs);
  assert.deepEqual(p.items.map(i => i.bucket), ['auto', 'confirm', 'confirm', 'confirm', 'info']);
  const q = plan(files, fs, { autoMajor: true, withMinor: true });
  assert.deepEqual(q.items.map(i => i.bucket), ['auto', 'auto', 'confirm', 'confirm', 'confirm']);
  assert.deepEqual(q.counts, { auto: 2, confirm: 3, info: 0, blocked: 0, done: 0 });
});

test('open 이 아닌 발견은 빼고 이미 처리됨으로 셈, status 누락은 open', () => {
  const p = plan({ 'src/a.js': 'const x = 1;\n' }, [
    finding({ id: 'F1', status: 'applied' }),
    finding({ id: 'F2', status: 'skipped' }),
    finding({ id: 'F3', status: undefined }),
  ]);
  assert.deepEqual(p.items.map(i => i.id), ['F3']);
  assert.equal(p.counts.done, 2);
});

test('리포트 생략 시 createdAt 이 가장 늦은 것을 고름', () => {
  const dir = makeDir({
    'src/a.js': 'const x = 1;\n',
    '.harness/reviews/new.json': JSON.stringify(report([finding({ id: 'NEW' })], { createdAt: '2026-11-25T12:00:00Z' })),
    '.harness/reviews/old.json': JSON.stringify(report([finding({ id: 'OLD' })], { createdAt: '2026-11-20T12:00:00Z' })),
  });
  const r = run(dir, '--json');
  assert.equal(r.status, 0, r.stderr);
  const out = JSON.parse(r.stdout);
  assert.ok(out.report.endsWith('new.json'));
  assert.deepEqual(out.items.map(i => i.id), ['NEW']);
});

test('리포트가 없거나 형식이 깨졌으면 exit 1', () => {
  const none = run(makeDir({}));
  assert.equal(none.status, 1);
  assert.match(none.stderr, /review 스킬을 먼저/);
  const dir = makeDir({ 'bad.json': '{ nope', 'shape.json': JSON.stringify({ findings: [{ id: 'F1' }] }) });
  assert.equal(run(dir, 'bad.json').status, 1);
  const shape = run(dir, 'shape.json');
  assert.equal(shape.status, 1);
  assert.match(shape.stderr, /severity/);
});

test('mark 는 status 를 바꿔 다시 쓰고, 모르는 id·상태는 거부', () => {
  const dir = makeDir({ 'r.json': JSON.stringify(report([finding()])) });
  const ok = run(dir, 'mark', 'r.json', 'F1', 'applied');
  assert.equal(ok.status, 0, ok.stderr);
  const text = readFileSync(join(dir, 'r.json'), 'utf8');
  assert.ok(text.endsWith('}\n'));
  assert.match(text, /\n  "version": 1/);
  assert.equal(JSON.parse(text).findings[0].status, 'applied');
  const badId = run(dir, 'mark', 'r.json', 'F9', 'applied');
  assert.equal(badId.status, 1);
  assert.match(badId.stderr, /F9/);
  assert.equal(run(dir, 'mark', 'r.json', 'F1', 'done').status, 1);
});

test('리뷰 이후 커밋이 생기면 경고, 미리보기에 표시', () => {
  const dir = makeDir({ 'src/a.js': 'const x = 1;\n' }, { repo: true });
  const head = git(dir, 'rev-parse', 'HEAD');
  writeFileSync(join(dir, 'r.json'), JSON.stringify(report([finding()], { head })));
  assert.deepEqual(JSON.parse(run(dir, 'r.json', '--json').stdout).warnings, []);
  git(dir, 'commit', '-q', '--allow-empty', '-m', 'next');
  const r = run(dir, 'r.json');
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /리뷰 이후 커밋이 추가됨/);
  assert.match(r.stdout, /-- 바로 적용 --\nF1 critical src\/a.js:1 제목/);
});

test('.harness.json review.protect 로 보호 목록을 바꾸고, 깨진 설정은 기본값', () => {
  const files = { 'src/a.js': 'const x = 1;\n', 'package.json': 'const x = 1;\n' };
  const fs = [finding({ id: 'F1' }), finding({ id: 'F2', file: 'package.json' })];
  const custom = plan({ ...files, '.harness.json': JSON.stringify({ review: { protect: ['src/**'] } }) }, fs);
  assert.deepEqual(custom.items.map(i => i.bucket), ['blocked', 'auto']);
  const broken = plan({ ...files, '.harness.json': '{ broken' }, fs);
  assert.deepEqual(broken.items.map(i => i.bucket), ['auto', 'blocked']);
});

test('리포트 스키마의 status enum 은 스크립트가 받는 값과 같음', () => {
  const schema = JSON.parse(readFileSync(new URL('../plugins/harness/schemas/review-report.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.properties.findings.items.properties.status.enum, STATUSES);
});

test('심볼릭 링크 경로로 실행해도 CLI 로 동작', () => {
  const dir = makeDir({ 'src/a.js': 'const x = 1;\n', 'r.json': JSON.stringify(report([finding()])) });
  const link = join(dir, 'link.mjs');
  symlinkSync(SCRIPT, link);
  const r = spawnSync(process.execPath, [link, 'r.json'], { cwd: dir, encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /바로 적용 1/);
});

test('같은 파일을 다른 표기(./)로 가리켜도 겹침을 잡음', () => {
  const p = plan({ 'src/a.js': 'const x = 1;\n' }, [finding(), finding({ id: 'F2', file: './src/a.js' })]);
  assert.deepEqual(p.items.map(i => i.bucket), ['confirm', 'confirm']);
});
