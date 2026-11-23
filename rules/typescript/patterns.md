# TypeScript

- `any` 금지. 모르는 값은 `unknown`으로 받고 좁힌다.
- 외부 응답(fetch, DB)은 인터페이스 또는 스키마 검증(zod 등)으로 타입을 세운다. `as` 캐스팅으로 덮지 않는다.
- `@ts-ignore`·`@ts-expect-error`는 이유 주석 없이 쓰지 않는다.
- null/undefined는 옵셔널 체이닝·널 병합으로 처리하고, 배열 필터 뒤에는 타입 가드를 쓴다.
- 반환 타입이 같은 종류인 함수들은 같은 형태를 반환한다.
