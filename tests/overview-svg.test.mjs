import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['overview-light.svg', 'overview-dark.svg'];

/** 스크립트를 임시 폴더에 실행해 지금 소스가 만드는 그림을 얻는다. */
function generate() {
  const dir = mkdtempSync(join(tmpdir(), 'harness-overview-'));
  const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-overview-svg.mjs'), dir], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const out = Object.fromEntries(FILES.map(f => [f, readFileSync(join(dir, f), 'utf8')]));
  rmSync(dir, { recursive: true, force: true });
  return out;
}

test('커밋된 개요 그림은 생성 스크립트 출력과 같다', () => {
  const fresh = generate();
  for (const f of FILES) {
    assert.equal(readFileSync(join(ROOT, 'docs', f), 'utf8'), fresh[f], `${f} 이 오래됐다. node scripts/build-overview-svg.mjs 를 다시 실행하라.`);
  }
});

test('개요 그림의 리뷰어 수는 agents/reviewer-*.md 수와 같다', () => {
  const reviewers = readdirSync(join(ROOT, 'agents')).filter(f => /^reviewer-.+\.md$/.test(f)).length;
  const desc = generate()['overview-light.svg'].match(/리뷰어 (\d+)개/);
  assert.ok(desc, '그림 설명에 리뷰어 수가 없다');
  assert.equal(Number(desc[1]), reviewers);
});

test('README 는 밝은·어두운 그림을 모두 참조한다', () => {
  const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
  for (const f of FILES) assert.ok(readme.includes(`docs/${f}`), f);
});
