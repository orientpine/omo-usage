# omo-usage

**English** · [한국어](README.ko.md)

A terminal UI that shows the **remaining quota of every account** signed in to omo-ai (senpi), plus **which account is being drained right now**, on one screen.

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
[![Runtime: Bun ≥ 1.2](https://img.shields.io/badge/Runtime-Bun%20%E2%89%A5%201.2-black?logo=bun)](https://bun.sh)
[![Install from GitHub](https://img.shields.io/badge/install-github%3Aorientpine%2Fomo--usage-blue?logo=github)](#quick-start)

<p align="center">
  <img src="docs/demo.png" width="670" alt="omo-usage TUI: per-account 5h/7d/per-model remaining bars, the in-use marker, and expiry reasons (demo data)">
</p>

<details>
<summary>Text version (the same demo data as the screenshot above)</summary>

```
  omo-ai 계정 사용량                               계정 7 · 정상 5 · 갱신 14:00:00
  ────────────────────────────────────────────────────────────────────────────────

  claude-sdk-oauth
  ▶ alice (고정) 5h    ██████████████████░░  88% 16:00 · 2시간 뒤
  │              7d    ████████████░░░░░░░░  61% 9/22 14:00 · 3일 뒤
  │              Fable ███████████████████░  96% 9/22 14:00 · 3일 뒤
  │              사용 중 · 방금

  ● bob          5h    ██████░░░░░░░░░░░░░░  32% 18:00 · 4시간 뒤
  │              7d    ██████░░░░░░░░░░░░░░  31% 9/24 14:00 · 5일 뒤
  │              Fable ░░░░░░░░░░░░░░░░░░░░   0% 9/24 14:00 · 5일 뒤
  │              마지막 사용 3시간 전

  ● carol        만료 · senpi가 사용 시 자동 갱신 · 재로그인 불필요
  │              마지막 사용 14시간 전

  openai-codex
  ● ann (pro)    7d    ██████████████░░░░░░  71% 9/23 14:00 · 4일 뒤

  ● dana (team)  5h    ████████████████████ 100% 15:00 · 1시간 뒤
  │              7d    █░░░░░░░░░░░░░░░░░░░   4% 9/25 14:00 · 6일 뒤

  xai
  ● default      7d    █████████████████░░░  87% 9/22 08:00 · 2일 18시간 뒤
  │              사용 내역 GrokBuild 12% · GrokImagine 1%

  google
  ● google       n/a · API key · 사용량 API 없음

  [r] 새로고침   [q] 종료
```

</details>

> [!NOTE]
> The TUI speaks Korean, so the frame above is verbatim program output rather than a translation. Glossary: `계정 사용량` account usage · `계정 7 · 정상 5` 7 accounts, 5 ok · `갱신 14:00:00` last refresh · `사용 중 · 방금` in use, just now · `마지막 사용 3시간 전` last used 3 hours ago · `만료` expired · `senpi가 사용 시 자동 갱신 · 재로그인 불필요` senpi refreshes it on next use, no re-login needed · `사용 내역` usage breakdown · `사용량 API 없음` no usage API · `[r] 새로고침` refresh · `[q] 종료` quit.

Once you run several Claude, Codex, xAI and Kimi accounts through senpi, you keep asking "how much is left on which account?" and "which one am I spending right now?" — and checking by hand every time gets old. omo-usage **only reads** the credentials and account-pool state senpi already stores, and shows the remaining percentage and reset time per account together with the account being drained right now. Tokens never appear on screen, in the output or in a log, and when a response cannot be interpreted it writes down the reason instead of inventing a number.

## Quick start

**You need**: [Bun](https://bun.sh) ≥ 1.2 and an omo-ai (senpi) login (`~/.omo/agent/auth.json`).

```sh
bun add -g github:orientpine/omo-usage   # or: npm i -g github:orientpine/omo-usage
omo-usage
```

Updating is the same command again. To remove it: `bun remove -g @orientpine/omo-usage`.

> [!NOTE]
> The code is Bun-only (`Bun.file`, `Bun.argv`, `.ts` run without a build step), so bun executes it even if you install through npm. senpi itself runs on bun, so senpi users have nothing extra to install.

## How it works

```
~/.omo/agent/auth.json                  ─ read only ─▶ account roster ─▶ per-provider usage API ─▶ remaining bars · reset times
~/.omo/agent/credential-pool-state.json ─ read only ─▶ lastSuccessAt per slot ─▶ ▶ in use · last used
```

It opens the two files senpi uses and writes not a single byte. Token refresh and account selection are entirely senpi's job, so leaving omo-usage running changes nothing about how senpi behaves. Usage is re-fetched every 150 seconds (longer than Anthropic's 429 cooldown), and the in-use marker comes from one local file, so that is re-read every 5 seconds.

## Usage

| Command | What it does |
| --- | --- |
| `omo-usage` | TUI. Usage refreshes every 150 s, the in-use marker (`▶`) every 5 s. `r` refreshes now, `q` / `Ctrl-C` quits |
| `omo-usage --once` | Fetch once, print one line per row, exit |
| `omo-usage --json` | The same result as JSON (no tokens) |
| `omo-usage --help` | Help |
| `omo-usage \| cat` | Piped anywhere it prints a single frame instead of the TUI |

### How to read the screen

- **One account = one block.** The first line carries the account name after `●` (Codex adds the plan, `(pro)`/`(team)`; a slot pinned by auth.json gets `(고정)`, pinned), and the windows below it are tied together by `│`.
- **The account being drained right now is `▶`.** If senpi completed a request on that account within the last 10 minutes, the marker turns into a green `▶` and the block ends with `사용 중 · 방금` (in use, just now). Anything older stays `●` with a dim `마지막 사용 3시간 전` (last used 3 hours ago). senpi picks an account per session, so there can be more than one `▶`. senpi keeps no such record for Codex, xAI and kimi-coding, so the TUI compares the previous fetch against the current one and writes the drop as `사용 중 · 방금 조회에서 -3%` (in use, −3% since the last fetch) — different evidence, so different wording (it is not an exact timestamp but somewhere inside the 150-second fetch interval, and since Codex reports whole percents anything below 1 pp goes unnoticed). Once it goes stale: `마지막 차감 감지 25분 전` (last drain detected 25 minutes ago). `--once`/`--json` have no previous fetch, so they show none of this. google has no usage API at all.
- **The bar and the percentage are what is left.** 100% means nothing used yet. Green ≥ 50% · yellow ≥ 20% · red < 20%.
- **Window names**: `5h` session, `7d` weekly, and a model name such as `Fable` means that model's weekly limit.
- **Reset times** read `16:00` when they fall today, otherwise `9/22 14:00`, followed by a relative time like `2시간 뒤` (in 2 hours).
- **xAI** turns its single weekly credit pool into the bar, and the `사용 내역 GrokBuild 12% · GrokImagine 1%` line below it is each product's share of that same pool (usage, not remaining).
- When a reason shows up instead of a bar:

| Display | Meaning |
| --- | --- |
| `만료 · senpi가 사용 시 자동 갱신 · 재로그인 불필요` | Only the access token expired. senpi refreshes it with the refresh token the moment it uses that account |
| `만료 · refresh 실패 · omo에서 /login <provider> (이름: <슬롯>)` | The refresh token is dead too. Re-authenticate with `/login` in the omo TUI |
| `요청 제한 (HTTP 429) · HH:MM 재시도` | The previous bar is kept as is, and the account is not called again before that time |
| `오류 · …` | HTTP error, timeout, or a response that cannot be parsed. No numbers are invented |
| `n/a · …` | A provider with no usage API (google) |

### JSON output

`--json` gives you an array of accounts. No tokens, no email addresses.

```json
[
  {
    "provider": "claude-sdk-oauth",
    "slot": "default",
    "label": "alice",
    "status": "ok",
    "detail": null,
    "plan": null,
    "expiresAt": 1789840800000,
    "windows": [
      { "label": "5h", "kind": "session", "remainingPercent": 88, "resetsAt": 1789830000000 },
      { "label": "7d", "kind": "weekly", "remainingPercent": 61, "resetsAt": 1790082000000 },
      { "label": "Fable", "kind": "scoped", "remainingPercent": 96, "resetsAt": 1790082000000 }
    ],
    "pinned": true,
    "lastUsedAt": 1789822760000
  }
]
```

- `status`: `ok` · `expired` · `error` · `unsupported`. `detail` is the reason string (`null` when there is none).
- `windows[].kind`: `session` (5h) · `weekly` (7d) · `scoped` (per model) · `other`. All times are epoch ms.
- `lastUsedAt`: when senpi last succeeded with that account (epoch ms, `lastSuccessAt` from `~/.omo/agent/credential-pool-state.json`). Providers that keep no such record (Codex, xAI, kimi-coding, google) do not carry the key at all. `pinned: true` appears only when auth.json pinned that slot. The drop detection for Codex, xAI and kimi-coding (`drained`) needs a previous fetch, so it exists in the TUI only and never in `--json`.
- While a 429 keeps the previous values, `retryAt` is added; the xAI per-product breakdown adds `note`.

```sh
# example: just the 7d remaining per account
omo-usage --json | jq -r '.[] | select(.status=="ok") | "\(.provider)/\(.label)\t\(.windows[] | select(.label=="7d") | .remainingPercent)%"'

# example: accounts being drained right now (last 10 minutes)
omo-usage --json | jq -r --argjson now "$(date +%s000)" '.[] | select(.lastUsedAt != null and $now - .lastUsedAt < 600000) | .label'
```

## FAQ

**Can I tell which account senpi is spending right now?**
The one marked `▶`. Every time a request succeeds, senpi writes that slot's `lastSuccessAt` into `~/.omo/agent/credential-pool-state.json`, and omo-usage marks every slot newer than 10 minutes as in use. The TUI re-reads only that file every 5 seconds, so it keeps up regardless of the 150-second usage fetch interval. There is a reason it refuses to declare "this one account": senpi picks an account per session by hash (preferring a pinned account when one exists), so with several sessions several accounts are drained at once. Hence more than one `▶` is possible, and the `방금` (just now) / `3분 전` (3 minutes ago) next to it is what you judge by. senpi keeps no such record for Codex, xAI and kimi-coding (`stored/slots` is empty for `openai-codex` and `kimi-coding`, and xai has no entry at all). For those three the TUI substitutes a comparison of remaining values between fetches — if the remainder dropped, `▶ … 사용 중 · 방금 조회에서 -3%`. That is not an exact timestamp but somewhere inside the 150-second fetch interval, and a rise caused by a reset does not count as drain. google has no usage API.

**It says expired — do I have to log in again?**
Usually not. An expired access token is normal, and as long as the refresh token is alive senpi refreshes it the moment it next uses that account. omo-usage only reads auth.json, so it cannot refresh on your behalf (refreshing directly would rotate the refresh token and corrupt senpi's stored copy) — it simply shows the expiry as it is. Re-login is needed only when `refresh 실패` (refresh failed) is attached, and then you run `/login claude-sdk-oauth` in the omo TUI and enter the existing slot name at the name prompt, which replaces it in place.

**Is there no shell command like `omo auth login`?**
There is not. `omo auth` only has `check` / `print-api-key` / `print-bearer-token`. Logging in is `/login <provider>` or `/claude-account add` inside the TUI.

**`요청 제한 (HTTP 429)` keeps showing up on my accounts.**
The Anthropic usage endpoint returns 429 for roughly 95 seconds after the last success per token, and it gets more frequent when it collides with senpi's own polling. On a 429 omo-usage keeps the previous bar and does not call that account again before the retry time, and the auto-refresh interval (150 s) is deliberately longer than that cooldown. The value is not gone — it just does not move for a while.

**Why is the xAI per-product breakdown not a bar?**
`GrokBuild 12% · GrokImagine 1%` are not each product's own limit but their shares of the same weekly pool, so drawing them as remaining bars would say something false. The only bar is the pool as a whole (`creditUsagePercent`).

**Can a token leak somewhere?**
auth.json is opened read-only and tokens are used in the fetch call and nowhere else. The screen state (`AccountRow`) never holds a token, so `--json` cannot expose one either. This tool does not write a single byte to auth.json.

## Supported providers

| provider | What you see | Where it comes from |
| --- | --- | --- |
| `claude-sdk-oauth` | Per-account 5h / 7d / per-model weekly limits | `GET https://api.anthropic.com/api/oauth/usage` (`anthropic-beta: oauth-2025-04-20`) |
| `openai-codex` | Per-account 5h / 7d plus the plan | `GET https://chatgpt.com/backend-api/wham/usage` (`ChatGPT-Account-Id` is extracted from the access-token JWT) |
| `xai` | Weekly credit pool remaining plus the per-product breakdown | `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits` — the same endpoint as Grok CLI's `/usage`. omo's xai token is issued by the same OIDC client as Grok CLI, so the bearer alone gets through |
| `kimi-coding` | Per-account 5h / 7d | `GET https://api.kimi.com/coding/v1/usages` — omo's Kimi subscription OAuth token (issued through the same device flow as Kimi CLI) is used as the bearer as is |
| `google` | — (`n/a`) | No published usage API |

## Design principles

- **Never invent a number.** If the response is empty or shaped differently, show the reason instead of a bar.
- **Never write to auth.json.** Refreshing tokens is senpi's job.
- **Expired ≠ dead.** The re-login hint is attached only to slots that senpi's failover stamped with `blockReason: "auth_error"`.
- **Never declare a single "current account".** senpi chooses per session, so every slot shows its own last-drain time and earns a `▶` when that is recent (10 minutes). Different evidence, different wording (`방금` vs `방금 조회에서 -3%`).
- **A 429 never erases a bar.** Keep the previous value, show the retry time, and do not call before it.
- **No line ever exceeds the terminal width.** Hangul and full-width glyph widths are measured by hand, so columns hold even with color applied.

<details>
<summary>Implementation notes (the traps in these response formats)</summary>

- **Codex windows are told apart by length, not by position.** Depending on the plan, `primary_window` can be the weekly one or the 5-hour one, so `limit_window_seconds` (18000 / 604800) decides.
- **Claude's per-model weekly limits live only in `weekly_scoped` inside `limits[]`.** Top-level keys such as `seven_day_opus` are usually `null`.
- **The xAI response is proto3 JSON, so a zero drops its key.** When `config.currentPeriod` is present but `creditUsagePercent` is missing, read it as 0 (100% remaining); when `currentPeriod` itself is missing it is not a credits response at all, so it stays an error. `{"val":0}` arrives as `{}`.
- **The Anthropic 429 window is about 95 seconds per token** (measured 2026-09-18). Use `Retry-After` when it is present, otherwise 120 seconds as the cooldown.
- **The xAI slot's label is `default`.** senpi stores no displayName for xai.
- **The drain record exists only in `credential-pool-state.json`.** `providers.<provider>.lanes.stored.slots.<slot>.lastSuccessAt` is updated on every successful request. `lease` is a half-open probe lock (30 s), not an in-use signal. Stale slot names and account-id keys linger in the file, so matching happens only against the current auth.json slot names, and Codex and kimi-coding slots are missing from it entirely (xai has no provider entry at all). That is why those three fall back to the drop in remaining values between TUI refreshes — `collect.ts` compares the previous result's `remainingPercent` per window label, keeps the largest drop as `drained`, never treats a rise (a reset) as a drain, and holds on to the previous detection when there is no new one.

</details>

## Development

```sh
git clone https://github.com/orientpine/omo-usage && cd omo-usage
bun install
bun test              # tests (fixtures are anonymized real responses)
bun run typecheck     # tsc --noEmit
bun run src/main.ts   # run locally (= bin/omo-usage.ts)
```

```
src/
  main.ts         CLI entry: --once / --json / --help, otherwise the TUI
  tui.ts          alternate screen, key input, 150 s auto refresh, 5 s pool-state refresh, 429 retry scheduling
  collect.ts      per-provider fetch, 429 cooldown, drop detection against the previous fetch
  parse.ts        response -> UsageWindow (Claude / Codex / xAI / Kimi)
  auth.ts         auth.json -> account roster, expiry verdict and reason, pinned slots
  pool.ts         credential-pool-state.json -> last drain time per slot (the in-use marker)
  credentials.ts  token map (kept apart from the screen state)
  render.ts       frame rendering: width math, color, the ● / ▶ / │ guides
  types.ts        AccountRow, UsageWindow
```

## License

[MIT](LICENSE)
