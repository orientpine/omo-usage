import type { AccountRow, AccountStatus } from "./types.ts";

/** usage API를 가진 provider와 그 종류. 여기 없는 provider는 전부 unsupported로 표시한다. */
export const USAGE_PROVIDERS = {
	"claude-sdk-oauth": "claude",
	"openai-codex": "codex",
	xai: "xai",
} as const;

export type UsageKind = (typeof USAGE_PROVIDERS)[keyof typeof USAGE_PROVIDERS];

/** 화면에 고정으로 쓰는 provider 순서. 나머지는 이름순으로 뒤에 붙는다. */
const PROVIDER_ORDER = ["claude-sdk-oauth", "openai-codex", "xai", "google"];

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function text(value: unknown): string | null {
	return typeof value === "string" && value.length > 0 ? value : null;
}

function orderOf(provider: string): number {
	const i = PROVIDER_ORDER.indexOf(provider);
	return i === -1 ? PROVIDER_ORDER.length : i;
}

function unsupportedDetail(entry: Record<string, unknown>): string {
	return entry["type"] === "api" ? "API key · 사용량 API 없음" : "사용량 API 없음";
}

/**
 * 액세스 토큰 만료는 대개 죽은 게 아니다. refresh token이 살아 있으면 senpi가 그 슬롯을 쓰는 순간 자동 갱신한다
 * (2026-09-19 실측: 한 슬롯이 14시간 만료 상태였다가 스스로 회복). 재로그인이 필요한 건 senpi failover가 refresh 실패를
 * `auth_error`로 찍은 슬롯뿐이고, 그 재로그인은 셸 명령이 아니라 TUI 슬래시 명령 `/login <provider>`다 (`omo auth login`은 없다).
 */
function expiredDetail(provider: string, slot: string, blockReason: unknown): string {
	return blockReason === "auth_error" ? `refresh 실패 · omo에서 /login ${provider} (이름: ${slot})` : "senpi가 사용 시 자동 갱신 · 재로그인 불필요";
}

/**
 * auth.json 전체를 받아 계정 한 줄씩으로 펼친다.
 * 토큰 값은 절대 담지 않는다 — 화면/로그로 새지 않게 하기 위해 만료 시각만 들고 온다.
 */
export function buildRoster(auth: unknown, now: number): AccountRow[] {
	const root = record(auth);
	if (!root) return [];

	const rows: AccountRow[] = [];
	const providers = Object.keys(root).sort((a, b) => orderOf(a) - orderOf(b) || a.localeCompare(b));

	for (const provider of providers) {
		const entry = record(root[provider]);
		if (!entry) continue;

		const supported = provider in USAGE_PROVIDERS;
		const accounts = Array.isArray(entry["accounts"]) ? entry["accounts"] : null;

		if (!supported) {
			rows.push({
				provider,
				slot: "default",
				label: provider,
				status: "unsupported",
				detail: unsupportedDetail(entry),
				plan: null,
				expiresAt: entry["type"] === "api" ? null : finite(entry["expires"]),
				windows: [],
			});
			continue;
		}

		const entries = accounts && accounts.length > 0 ? accounts : [{ ...entry, name: "default" }];
		for (const raw of entries) {
			const account = record(raw);
			if (!account) continue;
			const expiresAt = finite(account["expires"]);
			const status: AccountStatus = expiresAt !== null && expiresAt <= now ? "expired" : "loading";
			const slot = text(account["name"]) ?? "default";
			rows.push({
				provider,
				slot,
				label: text(account["displayName"]) ?? slot,
				status,
				detail: status === "expired" ? expiredDetail(provider, slot, account["blockReason"]) : null,
				plan: null,
				expiresAt,
				windows: [],
				...(text(entry["pinned"]) === slot ? { pinned: true as const } : {}),
			});
		}
	}

	return rows;
}
