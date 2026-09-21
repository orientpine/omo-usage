import { describe, expect, test } from "bun:test";
import { collectUsage, RATE_LIMIT_COOLDOWN_MS } from "../src/collect.ts";
import type { AccountRow } from "../src/types.ts";

const NOW = Date.UTC(2026, 8, 18, 4, 30, 0);
const future = NOW + 3_600_000;

const AUTH = {
	"claude-sdk-oauth": {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: future,
		accounts: [
			{ name: "default", displayName: "alice", access: "tok-alice", refresh: "r", expires: future, source: "login" },
			{ name: "bob", displayName: null, access: "tok-bob", refresh: "r", expires: future, source: "login" },
		],
	},
};

const OK_BODY = { five_hour: { utilization: 16, resets_at: "2026-09-18T09:00:00Z" }, seven_day: { utilization: 44, resets_at: "2026-09-22T00:00:00Z" } };
const LIMITED_BODY = { error: { type: "rate_limit_error", message: "Rate limited. Please try again later." } };

function fakeFetch(byToken: Record<string, number>): { fetchImpl: typeof fetch; calls: string[] } {
	const calls: string[] = [];
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		const token = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
		calls.push(token);
		const status = byToken[token] ?? 200;
		return new Response(JSON.stringify(status === 200 ? OK_BODY : LIMITED_BODY), { status, headers: { "content-type": "application/json" } });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

function find(rows: AccountRow[], slot: string): AccountRow {
	const row = rows.find((r) => r.slot === slot);
	if (!row) throw new Error(`row ${slot} missing`);
	return row;
}

describe("collectUsage · 429 처리", () => {
	test("첫 조회에서 429면 막대 없이 재시도 시각을 보여준다", async () => {
		const { fetchImpl } = fakeFetch({ "tok-bob": 429 });
		const rows = await collectUsage(AUTH, { fetchImpl, now: NOW });
		const bob = find(rows, "bob");
		expect(bob.status).toBe("error");
		expect(bob.windows).toEqual([]);
		expect(bob.detail).toContain("요청 제한");
		expect(bob.retryAt).toBe(NOW + RATE_LIMIT_COOLDOWN_MS);
		expect(find(rows, "default").status).toBe("ok");
	});

	test("이전 값이 있으면 429여도 막대를 유지하고 사유만 덧붙인다", async () => {
		const first = await collectUsage(AUTH, { fetchImpl: fakeFetch({}).fetchImpl, now: NOW });
		const { fetchImpl } = fakeFetch({ "tok-bob": 429 });
		const rows = await collectUsage(AUTH, { fetchImpl, now: NOW + 60_000, previous: first });
		const bob = find(rows, "bob");
		expect(bob.status).toBe("ok");
		expect(bob.windows).toEqual(find(first, "bob").windows);
		expect(bob.detail).toContain("요청 제한");
		expect(bob.retryAt).toBe(NOW + 60_000 + RATE_LIMIT_COOLDOWN_MS);
	});

	test("재시도 시각 전에는 그 계정을 아예 호출하지 않고 이전 줄을 그대로 돌려준다", async () => {
		const limited = await collectUsage(AUTH, { fetchImpl: fakeFetch({ "tok-bob": 429 }).fetchImpl, now: NOW });
		const { fetchImpl, calls } = fakeFetch({});
		const rows = await collectUsage(AUTH, { fetchImpl, now: NOW + 1_000, previous: limited });
		expect(calls).toEqual(["tok-alice"]);
		expect(find(rows, "bob")).toEqual(find(limited, "bob"));
	});

	test("재시도 시각이 지나면 다시 호출하고 성공하면 사유와 재시도 시각을 지운다", async () => {
		const limited = await collectUsage(AUTH, { fetchImpl: fakeFetch({ "tok-bob": 429 }).fetchImpl, now: NOW });
		const { fetchImpl, calls } = fakeFetch({});
		const rows = await collectUsage(AUTH, { fetchImpl, now: NOW + RATE_LIMIT_COOLDOWN_MS, previous: limited });
		expect(calls.sort()).toEqual(["tok-alice", "tok-bob"]);
		const bob = find(rows, "bob");
		expect(bob.status).toBe("ok");
		expect(bob.detail).toBeNull();
		expect(bob.retryAt).toBeUndefined();
	});

	test("Retry-After 헤더가 양수면 그 값을 쿨다운으로 쓴다", async () => {
		const fetchImpl = (async () => new Response(JSON.stringify(LIMITED_BODY), { status: 429, headers: { "retry-after": "90" } })) as unknown as typeof fetch;
		const rows = await collectUsage(AUTH, { fetchImpl, now: NOW });
		expect(find(rows, "default").retryAt).toBe(NOW + 90_000);
	});
});

describe("collectUsage · pool state", () => {
	const POOL = {
		providers: { "claude-sdk-oauth": { lanes: { stored: { slots: { default: { lastSuccessAt: NOW - 30_000 } } } } } },
	};

	test("pool state의 마지막 성공 시각을 계정 행에 붙인다", async () => {
		const rows = await collectUsage(AUTH, { fetchImpl: fakeFetch({}).fetchImpl, now: NOW, poolState: POOL });
		expect(find(rows, "default").lastUsedAt).toBe(NOW - 30_000);
		expect(find(rows, "bob").lastUsedAt).toBeUndefined();
	});

	test("429로 이전 막대를 유지한 행에도 붙는다", async () => {
		const first = await collectUsage(AUTH, { fetchImpl: fakeFetch({}).fetchImpl, now: NOW });
		const rows = await collectUsage(AUTH, {
			fetchImpl: fakeFetch({ "tok-alice": 429 }).fetchImpl,
			now: NOW + 60_000,
			previous: first,
			poolState: POOL,
		});
		const kept = find(rows, "default");
		expect(kept.detail).toContain("요청 제한");
		expect(kept.lastUsedAt).toBe(NOW - 30_000);
	});

	test("pool state가 없거나 깨졌으면 아무 행에도 붙지 않는다", async () => {
		for (const poolState of [undefined, null, "garbage", {}]) {
			const rows = await collectUsage(AUTH, { fetchImpl: fakeFetch({}).fetchImpl, now: NOW, poolState });
			expect(rows.every((r) => r.lastUsedAt === undefined)).toBe(true);
		}
	});
});

describe("collectUsage · 잔여 감소 감지 (pool 기록이 없는 provider)", () => {
	const CODEX_AUTH = { "openai-codex": { type: "oauth", access: "tok-codex", refresh: "r", expires: future, accountId: "acc" } };
	const codexBody = (used5h: number, used7d: number) => ({
		plan_type: "team",
		rate_limit: {
			primary_window: { used_percent: used5h, limit_window_seconds: 18000, reset_at: 1789643871 },
			secondary_window: { used_percent: used7d, limit_window_seconds: 604800, reset_at: 1790081482 },
		},
	});
	const serving = (body: unknown): typeof fetch =>
		(async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } })) as unknown as typeof fetch;

	test("직전 조회보다 잔여가 줄면 감지 시각과 가장 큰 감소 폭이 붙는다", async () => {
		const first = await collectUsage(CODEX_AUTH, { fetchImpl: serving(codexBody(40, 10)), now: NOW });
		expect(find(first, "default").drained).toBeUndefined();
		const second = await collectUsage(CODEX_AUTH, { fetchImpl: serving(codexBody(43, 11)), now: NOW + 150_000, previous: first });
		expect(find(second, "default").drained).toEqual({ at: NOW + 150_000, percent: 3 });
	});

	test("리셋으로 잔여가 늘거나 그대로면 새로 감지하지 않고 직전 감지를 유지한다", async () => {
		const first = await collectUsage(CODEX_AUTH, { fetchImpl: serving(codexBody(40, 10)), now: NOW });
		const second = await collectUsage(CODEX_AUTH, { fetchImpl: serving(codexBody(43, 11)), now: NOW + 150_000, previous: first });
		const reset = await collectUsage(CODEX_AUTH, { fetchImpl: serving(codexBody(0, 11)), now: NOW + 300_000, previous: second });
		expect(find(reset, "default").drained).toEqual({ at: NOW + 150_000, percent: 3 });
		const same = await collectUsage(CODEX_AUTH, { fetchImpl: serving(codexBody(0, 11)), now: NOW + 450_000, previous: reset });
		expect(find(same, "default").drained).toEqual({ at: NOW + 150_000, percent: 3 });
	});
});

describe("collectUsage · xai", () => {
	const XAI_AUTH = { xai: { type: "oauth", access: "tok-xai", refresh: "r", expires: future } };
	const XAI_BODY = {
		config: {
			currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-15T02:26:42Z", end: "2026-09-22T02:26:42Z" },
			creditUsagePercent: 13,
			productUsage: [
				{ product: "GrokBuild", usagePercent: 12 },
				{ product: "GrokImagine", usagePercent: 1 },
			],
		},
	};

	function xaiFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; seen: { url: string; headers: Headers }[] } {
		const seen: { url: string; headers: Headers }[] = [];
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			seen.push({ url: String(url), headers: new Headers(init?.headers) });
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		return { fetchImpl, seen };
	}

	test("cli-chat-proxy billing 엔드포인트를 베어러만으로 부르고 7d 창과 내역을 만든다", async () => {
		const { fetchImpl, seen } = xaiFetch(XAI_BODY);
		const rows = await collectUsage(XAI_AUTH, { fetchImpl, now: NOW });
		expect(seen.map((s) => s.url)).toEqual(["https://cli-chat-proxy.grok.com/v1/billing?format=credits"]);
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok-xai");
		const xai = find(rows, "default");
		expect(xai.provider).toBe("xai");
		expect(xai.status).toBe("ok");
		expect(xai.windows).toEqual([{ label: "7d", kind: "weekly", remainingPercent: 87, resetsAt: Date.parse("2026-09-22T02:26:42Z") }]);
		expect(xai.note).toContain("GrokBuild 12%");
	});

	test("config가 null이면 숫자를 지어내지 않고 오류로 표시한다", async () => {
		const rows = await collectUsage(XAI_AUTH, { fetchImpl: xaiFetch({ config: null }).fetchImpl, now: NOW });
		const xai = find(rows, "default");
		expect(xai.status).toBe("error");
		expect(xai.windows).toEqual([]);
		expect(xai.note).toBeUndefined();
	});
});

describe("collectUsage · kimi-coding", () => {
	const KIMI_AUTH = { "kimi-coding": { type: "oauth", access: "tok-kimi", refresh: "r", expires: future } };
	const KIMI_BODY = {
		usage: { limit: "100", used: "7", remaining: "93", resetTime: "2026-09-27T16:35:17Z" },
		limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "2", remaining: "98", resetTime: "2026-09-21T09:35:17Z" } }],
	};

	function kimiFetch(body: unknown, status = 200): { fetchImpl: typeof fetch; seen: { url: string; headers: Headers }[] } {
		const seen: { url: string; headers: Headers }[] = [];
		const fetchImpl = (async (url: unknown, init?: RequestInit) => {
			seen.push({ url: String(url), headers: new Headers(init?.headers) });
			return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
		}) as unknown as typeof fetch;
		return { fetchImpl, seen };
	}

	test("coding/v1/usages 엔드포인트를 베어러로 부르고 5h/7d 창을 만든다", async () => {
		const { fetchImpl, seen } = kimiFetch(KIMI_BODY);
		const rows = await collectUsage(KIMI_AUTH, { fetchImpl, now: NOW });
		expect(seen.map((s) => s.url)).toEqual(["https://api.kimi.com/coding/v1/usages"]);
		expect(seen[0]?.headers.get("authorization")).toBe("Bearer tok-kimi");
		const kimi = find(rows, "default");
		expect(kimi.provider).toBe("kimi-coding");
		expect(kimi.status).toBe("ok");
		expect(kimi.windows.map((w) => w.label)).toEqual(["5h", "7d"]);
		expect(kimi.windows.find((w) => w.label === "7d")?.remainingPercent).toBe(93);
	});

	test("사용량 창이 없는 응답이면 숫자를 지어내지 않고 오류로 표시한다", async () => {
		const rows = await collectUsage(KIMI_AUTH, { fetchImpl: kimiFetch({ usages: {} }).fetchImpl, now: NOW });
		const kimi = find(rows, "default");
		expect(kimi.status).toBe("error");
		expect(kimi.windows).toEqual([]);
	});
});
