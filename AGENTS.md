# my-harness 작업 지침

이 저장소는 개인 에이전트 하네스의 **원본**이다. 플랫폼 폴더(`.claude/`, `.codex/`, `.agents/`)는 설치 결과물이므로 직접 고치지 않는다.

## 구조

| 폴더 | 층 | 내용 |
|---|---|---|
| `rules/` | 1 지침 | 항상 지킬 규칙. `common/` + 스택별. 세션 시작 훅이 주입한다 |
| `contexts/` | 1 지침 | 작업 모드(dev/review/research)별 태도 |
| `hooks/` | 2 검증, 3 가드레일 | 이벤트와 스크립트 연결. 판단 로직은 `hooks/scripts/` |
| `skills/` | 4 절차 | 필요할 때만 읽히는 절차 (`SKILL.md`) |
| `agents/` | 7 위임 | 리뷰어·planner 서브에이전트 |
| `schemas/` | - | 리뷰 결과·레포 설정 형식 |
| `templates/` | - | 레포에 복사해 쓰는 `.harness.json`, `AGENTS.md` 초안 |
| `scripts/` | - | 다른 플랫폼용 내보내기 |
| `tests/` | - | 훅 판단 로직 테스트 (`node --test`) |

## 규칙

- 훅 스크립트는 Node 18+ 내장 모듈만 쓴다. 외부 의존(jq 등)을 늘리지 않는다.
- 훅의 판단 로직은 순수 함수로 분리하고 `tests/`에 테스트를 붙인다.
- 훅은 실패 시 조용히 통과(fail-open)한다. 단, `guard`의 차단 판단은 예외 없이 적용한다.
- 규칙 파일은 짧게 유지한다. 세션 시작 주입량 상한은 `hooks/scripts/session-start.mjs`의 `MAX_CHARS`.
- 변경 후 `npm test`를 통과시킨다.
