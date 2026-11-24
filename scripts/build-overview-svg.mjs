#!/usr/bin/env node
// README 개요 그림(docs/overview-light.svg, overview-dark.svg)을 만든다.
// 그림을 손으로 고치지 않고 이 파일의 내용을 바꾼 뒤 다시 실행한다:
//   node scripts/build-overview-svg.mjs
// GitHub 는 README 의 <picture> 로 밝은·어두운 테마에 맞는 파일을 고른다.
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = resolve(process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..', 'docs'));

const THEMES = {
  light: { box: '#f6f8fa', line: '#d0d7de', text: '#1f2328', muted: '#59636e', inject: '#0969da', guard: '#cf222e', verify: '#1a7f37', chip: '#ffffff' },
  dark: { box: '#161b22', line: '#30363d', text: '#e6edf3', muted: '#9198a1', inject: '#4493f8', guard: '#f85149', verify: '#3fb950', chip: '#0d1117' },
};

// 훅이 실행되는 다섯 지점. kind 가 색을 정한다 (inject 읽힌다 / guard 막는다 / verify 검사한다).
const HOOKS = [
  { when: '세션 시작', what: '규칙·교훈 주입', notes: ['공통·스택 규칙과', '레포 교훈 상위 6개'], kind: 'inject' },
  { when: '명령 실행 전', what: '위험 명령 차단', notes: ['rm -rf ~ · 강제 푸시', 'main 푸시·reset은 확인'], kind: 'guard' },
  { when: '파일 편집 직후', what: '고친 파일만 검사', notes: ['verify.onEdit', '예: ESLint'], kind: 'verify' },
  { when: '커밋 직전', what: '커밋 게이트', notes: ['verify.onCommit', '실패하면 커밋 차단'], kind: 'verify' },
  { when: '응답 종료 전', what: '완료 게이트', notes: ['verify.onStop', '3회 실패 시 사용자에게'], kind: 'verify' },
];
const REVIEWERS = ['보안', '품질', '백엔드', '프론트엔드', '컨벤션', '테스트'];
const LADDER = [
  { name: '메모', where: 'lessons.md' },
  { name: '규칙', where: 'AGENTS.md', after: '2회 반복' },
  { name: '훅', where: '차단·검사', after: '3회 반복' },
];

const W = 960, H = 530, PAD = 20;
const FONT = `system-ui, -apple-system, 'Segoe UI', 'Apple SD Gothic Neo', 'Malgun Gothic', 'Noto Sans KR', sans-serif`;
const MONO = `ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;

function render(c) {
  const out = [];
  const text = (x, y, s, { size = 13, fill = c.text, weight = 400, anchor = 'middle', family = FONT } = {}) =>
    out.push(`<text x="${x}" y="${y}" font-family="${family}" font-size="${size}" font-weight="${weight}" fill="${fill}" text-anchor="${anchor}">${s}</text>`);
  const rect = (x, y, w, h, { fill = c.box, stroke = c.line, r = 8 } = {}) =>
    out.push(`<rect x="${x}" y="${y}" width="${w}" height="${h}" rx="${r}" fill="${fill}" stroke="${stroke}"/>`);
  const arrow = (x1, y1, x2, y2) =>
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.muted}" stroke-width="1.5" marker-end="url(#arrow)"/>`);
  const line = (x1, y1, x2, y2) =>
    out.push(`<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c.line}" stroke-width="1.5"/>`);

  // ── 1. 훅 ──────────────────────────────────────────────
  text(PAD, 30, '작업 중 자동으로 실행되는 훅', { size: 14, weight: 600, anchor: 'start' });
  const legend = [['inject', '읽힌다'], ['guard', '막는다'], ['verify', '검사한다']];
  legend.forEach(([kind, label], i) => {
    const x = W - PAD - (legend.length - i) * 84;
    out.push(`<circle cx="${x + 6}" cy="25" r="5" fill="${c[kind]}"/>`);
    text(x + 17, 30, label, { size: 12, fill: c.muted, anchor: 'start' });
  });

  const BW = 168, BH = 118, GAP = 20, BY = 44;
  HOOKS.forEach((h, i) => {
    const x = PAD + i * (BW + GAP);
    const cx = x + BW / 2;
    rect(x, BY, BW, BH);
    out.push(`<rect x="${x + 1}" y="${BY + 1}" width="${BW - 2}" height="4" rx="2" fill="${c[h.kind]}"/>`);
    text(cx, BY + 30, h.when, { size: 12, fill: c.muted });
    text(cx, BY + 54, h.what, { size: 15, weight: 600 });
    h.notes.forEach((n, k) => text(cx, BY + 80 + k * 18, n, { size: 12, fill: c.muted, family: /^verify\./.test(n) ? MONO : FONT }));
    if (i < HOOKS.length - 1) arrow(x + BW + 3, BY + BH / 2, x + BW + GAP - 4, BY + BH / 2);
  });

  // ── 2. 스킬 ────────────────────────────────────────────
  const SY = 240, SH = 190;
  text(PAD, SY - 14, '요청하면 실행되는 스킬', { size: 14, weight: 600, anchor: 'start' });

  // 병렬 리뷰
  const LX = PAD, LW = 560;
  rect(LX, SY, LW, SH);
  text(LX + 16, SY + 28, '병렬 리뷰', { size: 14, weight: 600, anchor: 'start' });
  text(LX + LW - 16, SY + 28, '“PR 올리기 전에 리뷰해줘”', { size: 12, fill: c.muted, anchor: 'end' });
  const CW = 78, CG = 10, CY = SY + 50, CH = 32;
  const chipsW = REVIEWERS.length * CW + (REVIEWERS.length - 1) * CG;
  const chipX = i => LX + (LW - chipsW) / 2 + i * (CW + CG);
  const busY = CY + CH + 18, mid = LX + LW / 2;
  REVIEWERS.forEach((name, i) => {
    rect(chipX(i), CY, CW, CH, { fill: c.chip, r: 16 });
    text(chipX(i) + CW / 2, CY + 21, name, { size: 12 });
    line(chipX(i) + CW / 2, CY + CH, chipX(i) + CW / 2, busY);
  });
  line(chipX(0) + CW / 2, busY, chipX(REVIEWERS.length - 1) + CW / 2, busY);
  const RW = 300, RY = SY + 128, RH = 42;
  arrow(mid, busY, mid, RY - 4);
  rect(mid - RW / 2, RY, RW, RH, { fill: c.chip });
  text(mid, RY + 26, '통합 리포트 · critical / major / minor', { size: 13, weight: 600 });

  // 교훈 승격
  const RX = LX + LW + GAP, RWD = W - PAD - RX;
  rect(RX, SY, RWD, SH);
  text(RX + 16, SY + 28, '교훈 승격', { size: 14, weight: 600, anchor: 'start' });
  text(RX + RWD - 16, SY + 28, '“다음부터 이렇게 해”', { size: 12, fill: c.muted, anchor: 'end' });
  const PW = 72, PG = 52;
  const pillsW = LADDER.length * PW + (LADDER.length - 1) * PG;
  const pillX = i => RX + (RWD - pillsW) / 2 + i * (PW + PG);
  LADDER.forEach((s, i) => {
    const last = i === LADDER.length - 1;
    rect(pillX(i), CY, PW, CH, { fill: c.chip, stroke: last ? c.verify : c.line, r: 16 });
    text(pillX(i) + PW / 2, CY + 21, s.name, { size: 13, weight: 600, fill: last ? c.verify : c.text });
    text(pillX(i) + PW / 2, CY + CH + 20, s.where, { size: 11, fill: c.muted, family: /\.md$/.test(s.where) ? MONO : FONT });
    if (i > 0) {
      arrow(pillX(i - 1) + PW + 4, CY + CH / 2, pillX(i) - 5, CY + CH / 2);
      text(pillX(i) - PG / 2, CY - 6, s.after, { size: 11, fill: c.muted });
    }
  });
  text(RX + RWD / 2, SY + 150, '반복되는 실수는', { size: 13 });
  text(RX + RWD / 2, SY + 170, '기계가 지키게 한다', { size: 13, weight: 600 });

  // ── 3. 설정 ────────────────────────────────────────────
  const FY = 450, FH = 60;
  rect(PAD, FY, W - PAD * 2, FH);
  text(PAD + 16, FY + 26, '.harness.json', { size: 14, weight: 600, anchor: 'start', family: MONO });
  text(PAD + 140, FY + 26, '프로젝트마다 검사 명령·리뷰어·규칙 묶음을 고른다', { size: 13, anchor: 'start' });
  text(PAD + 16, FY + 46, '“이 레포 온보딩해줘”, “새 프로젝트 만들자”로 초안을 만든다. 없으면 규칙 주입과 위험 명령 차단만 동작한다.', { size: 12, fill: c.muted, anchor: 'start' });

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-labelledby="t d">
<title id="t">my-harness 개요</title>
<desc id="d">훅 다섯 지점(세션 시작, 명령 실행 전, 파일 편집 직후, 커밋 직전, 응답 종료 전), 병렬 리뷰 스킬의 리뷰어 ${REVIEWERS.length}개, 교훈이 메모에서 규칙과 훅으로 승격되는 과정, 프로젝트별 설정 파일.</desc>
<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0 10 5 0 10z" fill="${c.muted}"/></marker></defs>
${out.join('\n')}
</svg>
`;
}

mkdirSync(OUT_DIR, { recursive: true });
for (const [name, colors] of Object.entries(THEMES)) {
  const file = join(OUT_DIR, `overview-${name}.svg`);
  writeFileSync(file, render(colors));
  console.log(file);
}
