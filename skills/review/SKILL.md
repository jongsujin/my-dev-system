---
name: review
description: 현재 브랜치의 변경을 보안·품질·백엔드·프론트엔드(Toss 4축)·컨벤션·테스트 6개 리뷰어 서브에이전트로 병렬 리뷰하고, critical/major/minor 로 정리한 리포트를 만든다. "리뷰해줘", "PR 올리기 전에 봐줘", "코드 검토" 같은 요청이나 커밋·PR 직전에 쓴다.
---

# 병렬 코드 리뷰

리뷰 오케스트레이터로서 아래 순서를 따른다. 코드는 4단계에서 사용자가 고치기로 하기 전까지 고치지 않는다.

## 1. 범위 정하기

- 인자가 있으면 그것을 base로 쓴다. 없으면 `.harness.json`의 `review.base`, 그것도 없으면 `main`.
- base 해석 순서: `upstream/<base>` → `origin/<base>` → `<base>`. `git merge-base <ref> HEAD`가 처음 성공한 것을 쓴다.
- 변경 파일: `git diff --name-only <merge-base>...HEAD` 와 아직 커밋하지 않은 변경(`git status --porcelain`)을 합친다.
- 변경이 없으면 "리뷰할 변경이 없습니다"로 끝낸다.
- 변경 파일이 40개를 넘으면 사용자에게 범위를 줄일지 먼저 묻는다.

## 2. 리뷰어 고르기

기본은 `.harness.json`의 `review.reviewers` (없으면 여섯 개 전부). 인자 `--only <이름>` / `--skip <이름>` 을 반영한다.

| 리뷰어 | 서브에이전트 | 건너뛰는 조건 |
|---|---|---|
| security | `reviewer-security` | 없음 |
| quality | `reviewer-quality` | 문서·설정 파일만 바뀜 |
| backend | `reviewer-backend` | 서버 코드(API 라우트·서비스·DB 접근·작업 큐) 변경 없음 |
| frontend | `reviewer-frontend` | `.tsx .jsx .vue .svelte` 및 UI 폴더 변경 없음 |
| convention | `reviewer-convention` | 없음 (규칙 문서가 없으면 리뷰어가 스스로 skipped) |
| test | `reviewer-test` | 문서만 바뀜 |

서브에이전트 이름은 플랫폼마다 다르다.
- Claude Code (플러그인): `harness:reviewer-security`
- Codex (`scripts/codex-agents.mjs`로 설치한 역할): `harness_reviewer_security` 역할로 하위 에이전트를 생성한다
- 서브에이전트를 쓸 수 없는 환경: 관점별로 순서대로 직접 검토하되, 각 관점의 에이전트 정의(`agents/reviewer-*.md`)를 기준으로 삼는다

## 3. 병렬 호출

고른 리뷰어를 **한 응답 안에서 Agent 도구로 동시에** 호출한다. 순차 호출하지 않는다. 각 프롬프트에 넣을 것:

```
리뷰 범위
- base: <해석된 ref>  merge-base: <sha>  branch: <현재 브랜치>
- 변경 파일:
  - <path>
- 커밋:
  - <hash> <subject>
- 레포 설정: .harness.json 의 verify.commands (있으면 그대로)

담당 관점만 보고, 마지막에 ```json 블록 하나로 envelope 을 반환하라.
근거(파일·줄·원문 인용)가 없는 발견은 넣지 마라.
```

## 4. 통합과 보고

1. 각 응답에서 ```json 블록을 파싱한다. 실패한 리뷰어는 리포트 맨 위에 "⚠ <리뷰어> 응답 실패"로 표시하고 나머지로 진행한다.
2. **심각도 상한**: `verified: false`인 발견은 critical·major여도 minor로 낮추고 "(미확인)"을 붙인다.
3. **중복 합치기**: 같은 파일·줄·비슷한 제목은 하나로. 관점이 다르면 함께 표기한다.
4. 리포트를 같은 이름으로 두 파일에 저장한다: `.harness/reviews/<브랜치>-<YYYYMMDD-HHMMSS>.md`와 `.json` (`/`는 `_`로). `.json`은 `schemas/review-report.schema.json` 형식이다. `branch`·`base`·`mergeBase`·`head`(지금 `git rev-parse HEAD`)·`createdAt`(UTC)을 채우고, 발견에는 리포트 순서대로 `id`(`F1`부터), 합쳐진 리뷰어 전부를 `reviewers`에, `status: "open"`을 넣는다. 나머지 필드는 envelope 그대로 옮긴다.
5. 화면에는 이렇게 보여 준다:
   - 한 줄 결론 (머지해도 되는지)
   - critical → major → minor 순, 항목마다 `파일:줄`, 제목, 왜 문제인지 한 줄, 수정 방향
   - 건너뛴 리뷰어와 이유
6. 마지막에 묻는다: "critical·major를 지금 고칠까요?". 그렇다고 하면 직접 고치지 말고 `apply` 스킬 절차를 방금 저장한 `.json` 리포트로 따른다 (major 까지 원하면 `--auto-major`).
