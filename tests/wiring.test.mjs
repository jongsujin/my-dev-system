import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { normalizeConfig } from '../hooks/scripts/lib.mjs';

const root = new URL('../', import.meta.url);
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
