import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync } from 'node:fs';

const skills = new URL('../plugins/harness/skills/', import.meta.url);
const names = readdirSync(skills).filter(n => existsSync(new URL(`${n}/SKILL.md`, skills)));
const explicitOnly = new Set(['new-project']);

test('스킬마다 Codex agents/openai.yaml 이 있고 필요한 키를 담음', () => {
  assert.ok(names.length >= 4);
  for (const n of names) {
    const p = new URL(`${n}/agents/openai.yaml`, skills);
    assert.ok(existsSync(p), `${n}: agents/openai.yaml 없음`);
    const y = readFileSync(p, 'utf8');
    assert.match(y, /^interface:\s*$/m, n);
    assert.match(y, /^  display_name: ".+"$/m, n);
    const sd = y.match(/^  short_description: "(.+)"$/m);
    assert.ok(sd && sd[1].length <= 60, `${n}: short_description`);
    assert.match(y, new RegExp(`^  default_prompt: ".*\\$${n}\\b.*"$`, 'm'), n);
    assert.doesNotMatch(y, /brand_color/, n);
    assert.match(y, /^policy:\s*$/m, n);
    assert.match(y, new RegExp(`^  allow_implicit_invocation: ${!explicitOnly.has(n)}$`, 'm'), n);
  }
});
