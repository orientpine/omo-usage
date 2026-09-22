import type { AccountRow } from "./types.ts";
import { buildRoster, USAGE_PROVIDERS, type UsageKind } from "./auth.ts";
import { accountKey, secretsFrom, type Secret } from "./credentials.ts";
import { parseClaudeUsage, parseCodexUsage, parseKimiUsage, parseXaiUsage } from "./parse.ts";
import { stampLastUsed } from "./pool.ts";

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";
const CLAUDE_OAUTH_BETA = "oauth-2025-04-20";
const CODEX_USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";
/** Grok CLI `/usage`가 치는 엔드포인트. omo의 xai 토큰이 같은 OIDC 클라이언트로 발급돼 베어러만으로 200 (2026-09-18 실측). */
const XAI_USAGE_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";
/** Kimi Code 구독 사용량. omo의 kimi-coding OAuth 토큰을 베어러로 그대로 받는다 (2026-09-21 실측). */
const KIMI_USAGE_URL = "https://api.kimi.com/coding/v1/usages";
const REQUEST_TIMEOUT_MS = 15_000;
/** Anthropic usage 엔드포인트는 토큰당 마지막 성공 뒤 약 95초 동안 429를 돌려준다 (2026-09-18 실측). */
export const RATE_LIMIT_COOLDOWN_MS = 120_000;

export interface CollectOptions {
	readonly fetchImpl?: typeof fetch;
	readonly now?: number;
	readonly signal?: AbortSignal;
	/** 직전 결과. 429면 이전 막대를 유지하고, retryAt 전인 계정은 호출하지 않는다. */
	readonly previous?: readonly AccountRow[];
	/** senpi의 credential-pool-state.json 내용. 어느 계정이 실제로 차감되는지는 여기에만 있다. */
	readonly poolState?: unknown;
}

function timeoutSignal(outer: AbortSignal | undefined): AbortSignal {
	const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
	return outer ? AbortSignal.any([outer, timeout]) : timeout;
}

/** 에러 메시지에는 토큰이 절대 들어가지 않도록 상태 코드/사유만 남긴다. */
function httpDetail(status: number): string {
	if (status === 401 || status === 403) return `auth failed (HTTP ${status}) · re-login required`;
	if (status === 429) return "rate limited (HTTP 429)";
	return `HTTP ${status}`;
}

function retryAtFrom(response: Response, now: number): number {
	const seconds = Number(response.headers.get("retry-after"));
	return now + (Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : RATE_LIMIT_COOLDOWN_MS);
}

function rateLimited(row: AccountRow, previous: AccountRow | undefined, retryAt: number): AccountRow {
	const detail = httpDetail(429);
	if (previous && previous.windows.length > 0) return { ...previous, detail, retryAt };
	return { ...row, status: "error", detail, windows: [], retryAt };
}

function requestFor(kind: UsageKind, secret: Secret, signal: AbortSignal): { url: string; init: RequestInit } {
	switch (kind) {
		case "claude":
			return {
				url: CLAUDE_USAGE_URL,
				init: {
					headers: { Authorization: `Bearer ${secret.access}`, "anthropic-beta": CLAUDE_OAUTH_BETA, "User-Agent": "omo-usage/0.1" },
					signal,
				},
			};
		case "codex":
			return {
				url: CODEX_USAGE_URL,
				init: {
					headers: { Authorization: `Bearer ${secret.access}`, ...(secret.accountId ? { "ChatGPT-Account-Id": secret.accountId } : {}) },
					redirect: "error",
					signal,
				},
			};
		case "xai":
			return {
				url: XAI_USAGE_URL,
				init: { headers: { Authorization: `Bearer ${secret.access}`, "User-Agent": "omo-usage/0.1" }, signal },
			};
		case "kimi":
			return {
				url: KIMI_USAGE_URL,
				init: { headers: { Authorization: `Bearer ${secret.access}`, "User-Agent": "omo-usage/0.1" }, signal },
			};
	}
}

async function fetchOne(row: AccountRow, secret: Secret, options: CollectOptions, previous: AccountRow | undefined): Promise<AccountRow> {
	const doFetch = options.fetchImpl ?? fetch;
	const now = options.now ?? Date.now();
	const kind = USAGE_PROVIDERS[row.provider as keyof typeof USAGE_PROVIDERS];

	try {
		const request = requestFor(kind, secret, timeoutSignal(options.signal));
		const response = await doFetch(request.url, request.init);

		if (response.status === 429) return rateLimited(row, previous, retryAtFrom(response, now));
		if (!response.ok) {
			return { ...row, status: response.status === 401 ? "expired" : "error", detail: httpDetail(response.status) };
		}

		const payload = await response.json();
		if (kind === "claude") {
			const windows = parseClaudeUsage(payload);
			return windows.length > 0
				? { ...row, status: "ok", detail: null, windows }
				: { ...row, status: "error", detail: "no usage windows in response", windows: [] };
		}

		if (kind === "xai") {
			const usage = parseXaiUsage(payload);
			return usage.windows.length > 0
				? { ...row, status: "ok", detail: null, windows: usage.windows, ...(usage.note !== null ? { note: usage.note } : {}) }
				: { ...row, status: "error", detail: "no usage windows in response", windows: [] };
		}

		if (kind === "kimi") {
			const windows = parseKimiUsage(payload);
			return windows.length > 0
				? { ...row, status: "ok", detail: null, windows }
				: { ...row, status: "error", detail: "no usage windows in response", windows: [] };
		}

		const usage = parseCodexUsage(payload, now);
		return usage.windows.length > 0
			? { ...row, status: "ok", detail: null, plan: usage.plan, windows: usage.windows }
			: { ...row, status: "error", detail: "no usage windows in response", plan: usage.plan, windows: [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		const reason = message.includes("timed out") || message.includes("aborted") ? "timed out" : message.slice(0, 60);
		return { ...row, status: "error", detail: `fetch failed · ${reason}` };
	}
}

/**
 * pool-state에 기록이 없는 provider(Codex·xAI)는 직전 조회와 잔여를 비교해 차감을 알아챈다.
 * 잔여가 는 건 리셋이지 차감이 아니므로 감지하지 않고, 새 감지가 없으면 직전 감지를 그대로 넘긴다.
 */
function stampDrained(row: AccountRow, previous: AccountRow | undefined, now: number): AccountRow {
	const before = new Map((previous?.windows ?? []).map((window) => [window.label, window.remainingPercent]));
	let drop = 0;
	for (const window of row.windows) {
		const prior = before.get(window.label);
		if (prior !== undefined && window.remainingPercent < prior) drop = Math.max(drop, prior - window.remainingPercent);
	}
	if (drop > 0) return { ...row, drained: { at: now, percent: drop } };
	return previous?.drained === undefined ? row : { ...row, drained: previous.drained };
}

/** auth.json 전체를 훑어 계정마다 사용량을 병렬로 가져온다. 한 계정이 실패해도 나머지는 그대로 나온다. */
export async function collectUsage(auth: unknown, options: CollectOptions = {}): Promise<AccountRow[]> {
	const now = options.now ?? Date.now();
	const rows = buildRoster(auth, now);
	const secrets = secretsFrom(auth);
	const previous = new Map((options.previous ?? []).map((row) => [accountKey(row.provider, row.slot), row]));
	const resolve = async (row: AccountRow): Promise<AccountRow> => {
		if (row.status !== "loading") return row;
		const key = accountKey(row.provider, row.slot);
		const prev = previous.get(key);
		if (prev?.retryAt !== undefined && prev.retryAt > now) return prev;
		const secret = secrets.get(key);
		if (!secret) return { ...row, status: "error" as const, detail: "no access token" };
		return fetchOne(row, secret, { ...options, now }, prev);
	};

	const resolved = await Promise.all(rows.map(resolve));
	return stampLastUsed(resolved, options.poolState).map((row) => stampDrained(row, previous.get(accountKey(row.provider, row.slot)), now));
}
