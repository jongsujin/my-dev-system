import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { normalizeConfig } from '../plugins/harness/hooks/scripts/lib.mjs';

const root = new URL('../plugins/harness/', import.meta.url);
const read = p => readFileSync(new URL(p, root), 'utf8');
const agents = readdirSync(new URL('agents/', root))
  .filter(f => /^reviewer-.+\.md$/.test(f))
  .map(f => read(`agents/${f}`).match(/^name:\s*reviewer-(\S+)$/m)[1])
  .sort();

test('리뷰어 에이전트 ↔ envelope 스키마 enum 일치', () => {
  const schema = JSON.parse(read('schemas/review-envelope.schema.json'));
  assert.deepEqual([...schema.properties.reviewer.enum].sort(), agents);
});

test('리뷰어 에이전트 ↔ 설정 스키마 enum 일치', () => {
  const schema = JSON.parse(read('schemas/harness-config.schema.json'));
  assert.deepEqual([...schema.properties.review.properties.reviewers.items.enum].sort(), agents);
});

test('리뷰어 에이전트 ↔ normalizeConfig 기본 목록 일치', () => {
  assert.deepEqual([...normalizeConfig({}).review.reviewers].sort(), agents);
});

test('두 마켓플레이스가 Git 메타데이터 밖의 플러그인 폴더를 배포한다', () => {
  const repo = new URL('../', import.meta.url);
  const manifest = path => JSON.parse(readFileSync(new URL(path, repo), 'utf8'));
  const codex = manifest('.agents/plugins/marketplace.json').plugins[0];
  const claude = manifest('.claude-plugin/marketplace.json').plugins[0];
  assert.equal(codex.source.path, './plugins/harness');
  assert.equal(claude.source, codex.source.path);
  for (const platform of ['codex', 'claude']) {
    const plugin = manifest(`${codex.source.path}/.${platform}-plugin/plugin.json`);
    assert.equal(plugin.version, codex.version);
  }
});
