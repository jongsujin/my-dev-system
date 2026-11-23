#!/usr/bin/env node
// agents/*.md (Claude 서브에이전트) → Codex 멀티 에이전트 역할(.toml) 변환.
// Codex 플러그인은 에이전트를 설치하지 않으므로 이 스크립트로 따로 깐다.
//
//   node scripts/codex-agents.mjs            미리보기 (아무것도 쓰지 않음)
//   node scripts/codex-agents.mjs --apply    $CODEX_HOME(기본 ~/.codex) 에 설치
//   node scripts/codex-agents.mjs --remove   설치한 것 제거
//
// 설치 내용:
//   <CODEX_HOME>/agents/harness-<이름>.toml
//   <CODEX_HOME>/config.toml 의 "# >>> my-harness agents" ~ "# <<< my-harness agents" 블록
// config.toml 은 수정 전 config.toml.harness-backup 으로 백업한다.
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const BEGIN = '# >>> my-harness agents (scripts/codex-agents.mjs 가 관리)';
export const END = '# <<< my-harness agents';

/** 머리말(frontmatter)과 본문 분리. */
export function parseAgent(md) {
  const m = String(md).match(/^---\n([\s\S]*?)\n---\n?([\s\S]*)$/);
  if (!m) throw new Error('frontmatter 없음');
  const meta = Object.fromEntries(m[1].split('\n').map(l => l.match(/^(\w+):\s*(.*)$/)).filter(Boolean).map(x => [x[1], x[2].trim()]));
  return { meta, body: m[2].trim() };
}

/** TOML 여러 줄 리터럴 문자열. ''' 이 본문에 있으면 기본 문자열로 이스케이프. */
function tomlMultiline(s) {
  if (!s.includes("'''")) return `'''\n${s}\n'''`;
  return `"""\n${s.replace(/\\/g, '\\\\').replace(/"""/g, '\\"\\"\\"')}\n"""`;
}
const tomlString = s => JSON.stringify(s);

/** Claude 에이전트 → Codex 역할. 모델은 지정하지 않아 사용자 기본값을 따른다. */
export function toCodexRole(md) {
  const { meta, body } = parseAgent(md);
  const name = `harness_${meta.name.replace(/-/g, '_')}`;
  const readOnly = !/\b(Edit|Write)\b/.test(meta.tools || '');
  const instructions = `${body}\n\n(Codex 참고: 결과 형식은 하네스 저장소 schemas/review-envelope.schema.json 기준. 파일 수정 금지.)`;
  const toml = [
    `# my-harness: agents/${meta.name}.md 에서 생성. 원본을 고치고 다시 생성할 것.`,
    readOnly ? 'sandbox_mode = "read-only"' : '',
    `developer_instructions = ${tomlMultiline(instructions)}`,
    '',
  ].filter(l => l !== '').join('\n') + '\n';
  return { name, file: `harness-${meta.name}.toml`, description: meta.description || '', toml };
}

/** config.toml 에 넣을 관리 블록. */
export function configBlock(roles) {
  const lines = [BEGIN];
  for (const r of roles) {
    lines.push(`[agents.${r.name}]`, `description = ${tomlString(r.description)}`, `config_file = ${tomlString(`agents/${r.file}`)}`, '');
  }
  lines.push(END);
  return lines.join('\n');
}

/** 기존 관리 블록을 교체하거나 끝에 붙인다. block 이 null 이면 제거. */
export function upsertBlock(config, block) {
  const re = new RegExp(`\\n?${BEGIN.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${END}\\n?`);
  const stripped = config.replace(re, '\n').replace(/\n{3,}$/, '\n\n');
  if (!block) return stripped.trimEnd() + '\n';
  return `${stripped.trimEnd()}\n\n${block}\n`;
}

function main() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
  const mode = process.argv.includes('--apply') ? 'apply' : process.argv.includes('--remove') ? 'remove' : 'preview';

  const roles = readdirSync(join(root, 'agents')).filter(f => f.endsWith('.md')).sort()
    .map(f => toCodexRole(readFileSync(join(root, 'agents', f), 'utf8')));
  const configPath = join(codexHome, 'config.toml');
  const current = existsSync(configPath) ? readFileSync(configPath, 'utf8') : '';

  if (mode === 'preview') {
    console.log(`CODEX_HOME: ${codexHome}\n\n만들 파일:`);
    for (const r of roles) console.log(`  agents/${r.file}  → 역할 ${r.name}`);
    console.log(`\nconfig.toml 에 넣을 블록:\n\n${configBlock(roles)}\n\n설치: node scripts/codex-agents.mjs --apply`);
    return;
  }

  if (current) copyFileSync(configPath, `${configPath}.harness-backup`);
  const agentsDir = join(codexHome, 'agents');
  if (mode === 'remove') {
    for (const r of roles) rmSync(join(agentsDir, r.file), { force: true });
    writeFileSync(configPath, upsertBlock(current, null));
    console.log(`제거 완료 (백업: ${configPath}.harness-backup)`);
    return;
  }
  mkdirSync(agentsDir, { recursive: true });
  for (const r of roles) writeFileSync(join(agentsDir, r.file), r.toml);
  writeFileSync(configPath, upsertBlock(current, configBlock(roles)));
  console.log(`설치 완료: 역할 ${roles.length}개 → ${agentsDir}\nconfig.toml 갱신 (백업: ${configPath}.harness-backup)`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
