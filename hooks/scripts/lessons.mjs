// .harness/lessons.md 형식 파서. 순수 함수 (tests/lessons.test.mjs).
//
// 한 줄에 교훈 하나:
//   - [×3] 교훈 내용 <!-- level:rule updated:2026-11-23 -->
// ×N 은 반복 횟수. level 은 memo | rule | hook (승격 사다리 위치).

const LINE = /^\s*-\s*\[×(\d+)\]\s*(.+?)\s*(?:<!--\s*(.*?)\s*-->)?\s*$/;

export function parseLessons(md) {
  return String(md || '').split('\n').map(line => {
    const m = line.match(LINE);
    if (!m) return null;
    const meta = Object.fromEntries((m[3] || '').split(/\s+/).filter(Boolean).map(kv => kv.split(':')));
    return { count: Number(m[1]), text: m[2], level: meta.level || 'memo', updated: meta.updated || null };
  }).filter(Boolean);
}

/** 이미 훅으로 승격된 교훈은 기계가 지키므로 주입하지 않는다. */
export function topLessons(md, n) {
  return parseLessons(md)
    .filter(l => l.level !== 'hook')
    .sort((a, b) => b.count - a.count)
    .slice(0, Math.max(0, n));
}

/** 승격 후보: 기억 노트인데 2회 이상 → 규칙, 규칙인데 3회 이상 → 훅. */
export function promotionCandidates(md) {
  return parseLessons(md).flatMap(l => {
    if (l.level === 'memo' && l.count >= 2) return [{ ...l, to: 'rule' }];
    if (l.level === 'rule' && l.count >= 3) return [{ ...l, to: 'hook' }];
    return [];
  });
}
