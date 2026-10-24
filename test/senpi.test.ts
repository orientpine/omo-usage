import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectShared } from "../src/cache.ts";
import { readSenpiUsage, senpiUsagePath } from "../src/senpi.ts";
import type { AccountRow } from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 24, 5, 45, 0);
const future = NOW + 24 * 3_600_000;
const AUTH = {
	"anthropic-subscription": {
		type: "oauth",
		access: "sentinel-access",
		expires: future,
		accounts: [{ name: "default", displayName: "orientpine", access: "tok-default-SECRET", refresh: "ref-SECRET", expires: future }],
	},
};
const OK_BODY = { five_hour: { utilization: 10, resets_at: "2026-10-24T09:00:00Z" }, seven_day: { utilization: 10, resets_at: "2026-10-30T18:00:00Z" } };

/** senpi usage-poller가 쓰는 subscription-usage.json 모양 (senpi dist/core/subscription-limits/usage-cache.js). */
function senpiReading(over: Record<string, unknown> = {}) {
	return {
		windows: [
			{ id: "claude:5h", label: "5h", windowMinutes: 300, usedPercent: 29, resetsAt: "2026-10-24T08:59:59.826Z" },
			{ id: "claude:7d", label: "7d", windowMinutes: 10080, usedPercent: 38, resetsAt: "2026-10-30T17:59:59.826Z" },
			{ id: "claude:7d_fable", label: "7d fable", windowMinutes: 10080, usedPercent: 59, resetsAt: "2026-10-30T17:59:59.826Z" },
		],
		updatedAt: NOW - 2 * 60_000,
		nextAt: NOW + 3 * 60_000,
		...over,
	};
}

function tempDir(): string {
	return mkdtempSync(join(tmpdir(), "omo-usage-senpi-test-"));
}

function senpiFile(dir: string, accounts: Record<string, unknown>): string {
	const path = join(dir, "subscription-usage.json");
	writeFileSync(path, JSON.stringify({ accounts, fetching: {} }));
	return path;
}

/** 9시간 전에 성공하고 그 뒤로는 429만 받은 omo-usage 공유 캐시 (2026-10-24 실제 상태). */
function staleCache(dir: string): string {
	const path = join(dir, "usage.json");
	const row: AccountRow = {
		provider: "anthropic-subscription",
		slot: "default",
		label: "orientpine",
		status: "ok",
		detail: null,
		plan: null,
		expiresAt: future,
		windows: [
			{ label: "5h", kind: "session", remainingPercent: 53, resetsAt: NOW - 6 * 3_600_000 },
			{ label: "7d", kind: "weekly", remainingPercent: 92, resetsAt: NOW + 6 * 86_400_000 },
			{ label: "Fable", kind: "scoped", remainingPercent: 88, resetsAt: NOW + 6 * 86_400_000 },
		],
		fetchedAt: NOW - 9 * 3_600_000,
		retryAt: NOW - 60_000,
	};
	writeFileSync(path, JSON.stringify({ version: 1, accounts: { "anthropic-subscription/default": { checkedAt: NOW - 11 * 60_000, row } } }));
	return path;
}

function countingFetch(status = 429) {
	const calls: string[] = [];
	const fetchImpl = (async (url: unknown) => {
		calls.push(String(url));
		return new Response(JSON.stringify(status === 200 ? OK_BODY : { error: { type: "rate_limit_error" } }), { status });
	}) as unknown as typeof fetch;
	return { fetchImpl, calls };
}

describe("readSenpiUsage · senpi가 이미 받아 둔 사용량", () => {
	test("Claude 창을 남은 비율로 바꾸고, 오류가 붙은 읽기·창 없는 읽기·다른 provider는 버린다", async () => {
		const path = senpiFile(tempDir(), {
			"anthropic-subscription/default": senpiReading(),
			"anthropic-subscription/baekdongc": senpiReading({ error: "rate limited" }),
			"anthropic-subscription/cbaekdong": senpiReading({ windows: [] }),
			"chatgpt-subscription/default": senpiReading(),
		});
		const readings = await readSenpiUsage(path);
		expect([...readings.keys()]).toEqual(["anthropic-subscription/default"]);
		expect(readings.get("anthropic-subscription/default")).toEqual({
			fetchedAt: NOW - 2 * 60_000,
			windows: [
				{ label: "5h", kind: "session", remainingPercent: 71, resetsAt: Date.parse("2026-10-24T08:59:59.826Z") },
				{ label: "7d", kind: "weekly", remainingPercent: 62, resetsAt: Date.parse("2026-10-30T17:59:59.826Z") },
				{ label: "Fable", kind: "scoped", remainingPercent: 41, resetsAt: Date.parse("2026-10-30T17:59:59.826Z") },
			],
		});
	});

	test("파일이 없거나 깨졌으면 비어 있다", async () => {
		const dir = tempDir();
		expect((await readSenpiUsage(join(dir, "missing.json"))).size).toBe(0);
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{not json");
		expect((await readSenpiUsage(broken)).size).toBe(0);
	});

	test("경로는 OMO_USAGE_SENPI_USAGE_PATH, 없으면 auth.json 옆의 subscription-usage.json", () => {
		expect(senpiUsagePath({ OMO_USAGE_SENPI_USAGE_PATH: "/x/y.json" })).toBe("/x/y.json");
		expect(senpiUsagePath({})).toMatch(/\/\.omo\/agent\/subscription-usage\.json$/);
	});
});

describe("collectShared · senpi 값 쓰기", () => {
	test("senpi 값이 더 새롭고 간격 안이면 Anthropic을 부르지 않고 그 값과 그 시각을 보인다", async () => {
		const dir = tempDir();
		const { fetchImpl, calls } = countingFetch();
		const rows = await collectShared(AUTH, {
			now: NOW,
			fetchImpl,
			cachePath: staleCache(dir),
			senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading() }),
		});
		expect(calls).toEqual([]);
		const row = rows.find((r) => r.slot === "default");
		expect(row?.status).toBe("ok");
		expect(row?.fetchedAt).toBe(NOW - 2 * 60_000);
		expect(row?.retryAt).toBeUndefined();
		expect(row?.windows.map((w) => `${w.label} ${w.remainingPercent}`)).toEqual(["5h 71", "7d 62", "Fable 41"]);
	});

	test("본 senpi 값은 캐시에 남아, senpi가 다음에 429를 받아도 그 값을 계속 보이고 간격 안에는 부르지 않는다", async () => {
		const dir = tempDir();
		const { fetchImpl, calls } = countingFetch();
		const cachePath = staleCache(dir);
		await collectShared(AUTH, { now: NOW, fetchImpl, cachePath, senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading() }) });
		const later = await collectShared(AUTH, {
			now: NOW + 5 * 60_000,
			fetchImpl,
			cachePath,
			senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading({ error: "rate limited", updatedAt: NOW + 4 * 60_000 }) }),
		});
		expect(calls).toEqual([]);
		const row = later.find((r) => r.slot === "default");
		expect(row?.fetchedAt).toBe(NOW - 2 * 60_000);
		expect(row?.windows[0]?.remainingPercent).toBe(71);
	});

	test("senpi 읽기에 오류가 붙어 있으면 쓰지 않는다: 직접 조회하고 429면 이전 막대를 그대로 둔다", async () => {
		const dir = tempDir();
		const { fetchImpl, calls } = countingFetch(429);
		const rows = await collectShared(AUTH, {
			now: NOW,
			fetchImpl,
			cachePath: staleCache(dir),
			senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading({ error: "rate limited" }) }),
		});
		expect(calls.length).toBe(1);
		const row = rows.find((r) => r.slot === "default");
		expect(row?.fetchedAt).toBe(NOW - 9 * 3_600_000);
		expect(row?.windows[0]?.remainingPercent).toBe(53);
	});

	test("간격보다 오래된 senpi 값은 조회를 막지 않지만, 429면 캐시보다 새로운 senpi 값을 남긴다", async () => {
		const dir = tempDir();
		const { fetchImpl, calls } = countingFetch(429);
		const rows = await collectShared(AUTH, {
			now: NOW,
			fetchImpl,
			cachePath: staleCache(dir),
			senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading({ updatedAt: NOW - 3 * 3_600_000 }) }),
		});
		expect(calls.length).toBe(1);
		const row = rows.find((r) => r.slot === "default");
		expect(row?.fetchedAt).toBe(NOW - 3 * 3_600_000);
		expect(row?.windows[0]?.remainingPercent).toBe(71);
	});

	test("omo-usage가 직접 받은 값이 더 새로우면 senpi 값으로 덮지 않고, 미래 시각의 senpi 값도 무시한다", async () => {
		const dir = tempDir();
		const { fetchImpl, calls } = countingFetch(200);
		const cachePath = join(dir, "fresh.json");
		await collectShared(AUTH, { now: NOW, fetchImpl, cachePath, senpiUsagePath: join(dir, "none.json") });
		expect(calls.length).toBe(1);
		const rows = await collectShared(AUTH, {
			now: NOW + 60_000,
			fetchImpl,
			cachePath,
			senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading({ updatedAt: NOW - 60_000 }) }),
		});
		expect(rows.find((r) => r.slot === "default")?.windows[0]?.remainingPercent).toBe(90);
		const ahead = await collectShared(AUTH, {
			now: NOW + 60_000,
			fetchImpl,
			cachePath,
			senpiUsagePath: senpiFile(dir, { "anthropic-subscription/default": senpiReading({ updatedAt: NOW + 3_600_000 }) }),
		});
		expect(ahead.find((r) => r.slot === "default")?.windows[0]?.remainingPercent).toBe(90);
		expect(calls.length).toBe(1);
	});
});
