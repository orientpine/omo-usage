# omo-usage

omo-ai(senpi)에 로그인된 **모든 계정의 잔여 사용량**을 한 화면에서 보여주는 TUI.

## 설치

[Bun](https://bun.sh) ≥ 1.2 와 omo-ai(senpi) 로그인이 필요하다 (`~/.omo/agent/auth.json` 을 읽기 전용으로 연다).

```sh
bun add -g github:orientpine/omo-usage
# 또는
npm i -g github:orientpine/omo-usage
```

## 실행

```
omo-usage            # TUI (r 새로고침 · q 종료 · 150초 자동 갱신)
omo-usage --once     # 한 번만 출력
omo-usage --json     # JSON 출력 (토큰은 절대 포함하지 않음)
```

## 개발

```sh
git clone https://github.com/orientpine/omo-usage && cd omo-usage
bun install
bun test              # 테스트
bun run typecheck     # tsc --noEmit
bun run src/main.ts   # 로컬 실행
```

## 어디서 읽는가

`~/.omo/agent/auth.json` 을 **읽기 전용**으로 열어 provider별 계정 목록을 만든다.
토큰 값은 fetch 호출에만 쓰이고 화면 상태나 JSON 출력에는 절대 들어가지 않는다.

| provider | 사용량 조회 | 엔드포인트 |
| --- | --- | --- |
| claude-sdk-oauth | 계정별 5h / 7d / 모델별 주간 한도 | `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`) |
| openai-codex | 계정별 5h / 7d | `GET https://chatgpt.com/backend-api/wham/usage` (`ChatGPT-Account-Id`는 액세스 토큰 JWT에서 추출) |
| xai | 주간 크레딧 풀 사용률 (`7d`) + 제품별 내역 (GrokBuild / GrokImagine) | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` — Grok CLI `/usage`가 쓰는 엔드포인트. omo의 xai 토큰이 Grok CLI와 같은 OIDC 클라이언트로 발급돼 OAuth 베어러만으로 200 |
| google | 공개된 사용량 API 없음 → `n/a` 로 표시 | — |

## 설계상 지킨 것

- **숫자를 지어내지 않는다.** 응답이 비었거나 형식이 다르면 막대 대신 사유(`만료`, `오류`, `n/a`)를 보여준다.
- **창은 위치가 아니라 길이로 구분한다.** Codex는 계정 플랜에 따라 `primary_window`가 주간이기도 5시간이기도 해서, `limit_window_seconds`(18000 / 604800)로 판별한다.
- **auth.json에 쓰지 않는다.** 토큰 갱신은 senpi 몫이며, 만료된 토큰은 갱신하지 않고 `만료`로 표시한다.
- **`만료`는 대개 죽은 게 아니다.** refresh token이 살아 있으면 senpi가 그 슬롯을 쓰는 순간 자동 갱신하므로 재로그인을 요구하지 않는다. 재로그인 안내(`omo에서 /login <provider>`)는 senpi failover가 refresh 실패를 `blockReason: "auth_error"`로 찍은 슬롯에만 붙인다. `omo auth login`이라는 셸 명령은 존재하지 않는다(`omo auth`는 check / print-api-key / print-bearer-token뿐).
- **429를 맞아도 막대를 지우지 않는다.** Anthropic usage 엔드포인트는 토큰당 마지막 성공 뒤 약 95초 동안 429를 돌려준다(2026-09-18 실측). 429가 오면 직전 값을 그대로 두고 막대 옆에 `요청 제한 (HTTP 429) · HH:MM 재시도`를 적으며, 그 시각 전에는 그 계정을 다시 호출하지 않는다. 자동 갱신 주기(150초)도 이 쿨다운보다 길게 잡았다.
- **계정마다 한 블록.** 같은 provider 안에서도 계정 사이에 빈 줄을 두고, 첫 줄은 `●`, 이어지는 창(7d, 모델별)은 `│` 가이드로 묶는다.
- **xAI 제품별 내역은 막대가 아니라 문구다.** `productUsage[]`의 GrokBuild 12% / GrokImagine 1%는 각 제품의 한도가 아니라 같은 주간 풀에서 쓴 몫이라, 잔여 막대로 그리면 뜻이 틀린다. 막대는 `creditUsagePercent` 하나만 두고 내역은 그 아래 `│` 줄에 dim으로 적는다.
- **xAI 응답은 proto3 JSON이라 0은 키가 빠진다.** `config.currentPeriod`가 있는데 `creditUsagePercent`만 없으면 0(= 잔여 100%)으로 읽는다. `currentPeriod` 자체가 없으면 크레딧 응답이 아니므로 `오류`로 둔다.
