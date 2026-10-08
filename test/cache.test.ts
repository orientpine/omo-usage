import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectShared, DEFAULT_REFRESH_MS, LOCK_STALE_MS, refreshIntervalMs } from "../src/cache.ts";
import { RATE_LIMIT_COOLDOWN_MS } from "../src/collect.ts";
import type { AccountRow } from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 8, 5, 0, 0);
const future = NOW + 24 * 3_600_000;
const AUTH = {
	"anthropic-subscription": {
		type: "oauth",
		access: "sentinel-access",
		refresh: "sentinel-refresh",
		expires: future,
		accounts: [
			{ name: "alice", displayName: "alice", access: "tok-alice-SECRET", refresh: "ref-alice-SECRET", expires: future },
			{ name: "bob", displayName: "bob", access: "tok-bob-SECRET", refresh: "ref-bob-SECRET", expires: future },
		],
	},
};
const OK_BODY = { five_hour: { utilization: 16, resets_at: "2026-10-08T09:00:00Z" }, seven_day: { utilization: 44, resets_at: "2026-10-12T00:00:00Z" } };

function tempCache(): string {
	return join(mkdtempSync(join(tmpdir(), "omo-usage-cache-test-")), "usage.json");
}

/** 토큰별 응답 코드를 고를 수 있는 가짜 fetch. gate를 주면 그 약속이 풀릴 때까지 응답을 붙든다. */
function fakeFetch(statusOf: (token: string) => number = () => 200, gate?: Promise<void>) {
	const calls: string[] = [];
	let started: () => void = () => {};
	const firstCall = new Promise<void>((resolve) => {
		started = resolve;
	});
	const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
		const token = String(new Headers(init?.headers).get("authorization")).replace("Bearer ", "");
		calls.push(token);
		started();
		if (gate) await gate;
		const status = statusOf(token);
		return new Response(JSON.stringify(status === 200 ? OK_BODY : { error: { type: "rate_limit_error" } }), {
			status,
			headers: status === 429 ? { "retry-after": "600" } : {},
		});
	}) as unknown as typeof fetch;
	return { fetchImpl, calls, firstCall };
}

const bob = (rows: AccountRow[]) => rows.find((row) => row.slot === "bob");

describe("collectShared · 머신 공유 캐시", () => {
	test("여러 프로세스가 동시에 떠도 계정당 실제 조회는 간격 안에 한 번뿐이다", async () => {
		const cachePath = tempCache();
		let open: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			open = resolve;
		});
		const { fetchImpl, calls, firstCall } = fakeFetch(() => 200, gate);

		const owner = collectShared(AUTH, { fetchImpl, now: NOW, cachePath });
		await firstCall;
		// 주인이 잠금을 쥔 채 조회하는 동안 다른 두 프로세스가 뜬다. 이들은 주인이 끝나기를 기다렸다가 캐시를 읽는다.
		const ownerDone = owner.then(() => {});
		const waiters = [1, 2].map(() => collectShared(AUTH, { fetchImpl, now: NOW + 1_000, cachePath, sleep: () => ownerDone }));
		open();
		const results = await Promise.all([owner, ...waiters]);

		expect(calls.sort()).toEqual(["tok-alice-SECRET", "tok-bob-SECRET"]);
		for (const rows of results) {
			expect(rows.map((row) => `${row.slot} ${row.status} ${row.windows.length}`)).toEqual(["alice ok 2", "bob ok 2"]);
			expect(bob(rows)?.fetchedAt).toBe(NOW);
		}

		calls.length = 0;
		await collectShared(AUTH, { fetchImpl, now: NOW + DEFAULT_REFRESH_MS - 1, cachePath });
		expect(calls).toEqual([]);
		await collectShared(AUTH, { fetchImpl, now: NOW + DEFAULT_REFRESH_MS, cachePath });
		expect(calls.sort()).toEqual(["tok-alice-SECRET", "tok-bob-SECRET"]);
	});

	test("429 뒤에는 retryAt 전까지 어느 프로세스도(강제 새로고침이어도) 그 계정을 부르지 않고, 이전 막대를 오류 없이 유지한다", async () => {
		const cachePath = tempCache();
		const first = fakeFetch();
		const before = await collectShared(AUTH, { fetchImpl: first.fetchImpl, now: NOW, cachePath });

		const limited = fakeFetch((token) => (token.startsWith("tok-bob") ? 429 : 200));
		const t1 = NOW + DEFAULT_REFRESH_MS;
		const kept = await collectShared(AUTH, { fetchImpl: limited.fetchImpl, now: t1, cachePath });
		expect(limited.calls.sort()).toEqual(["tok-alice-SECRET", "tok-bob-SECRET"]);
		expect(bob(kept)).toMatchObject({ status: "ok", detail: null, fetchedAt: NOW, retryAt: t1 + 600_000 });
		expect(bob(kept)?.windows).toEqual(bob(before)?.windows ?? []);

		const later = fakeFetch();
		const blocked = await collectShared(AUTH, { fetchImpl: later.fetchImpl, now: t1 + 599_000, cachePath, force: true });
		expect(later.calls).toEqual(["tok-alice-SECRET"]);
		expect(bob(blocked)?.detail).toBeNull();
		expect(bob(blocked)?.windows.length).toBe(2);

		later.calls.length = 0;
		await collectShared(AUTH, { fetchImpl: later.fetchImpl, now: t1 + 600_000, cachePath });
		expect(later.calls).toEqual(["tok-bob-SECRET"]);
	});

	test("처음 조회에서 429면 이전 값이 없으니 사유와 재시도 시각을 보이고, 그 전에는 다시 부르지 않는다", async () => {
		const cachePath = tempCache();
		const limited = fakeFetch((token) => (token.startsWith("tok-bob") ? 429 : 200));
		const rows = await collectShared(AUTH, { fetchImpl: limited.fetchImpl, now: NOW, cachePath });
		expect(bob(rows)).toMatchObject({ status: "error", detail: "rate limited (HTTP 429)", retryAt: NOW + 600_000 });
		const again = fakeFetch();
		await collectShared(AUTH, { fetchImpl: again.fetchImpl, now: NOW + 300_000, cachePath, force: true });
		expect(again.calls).toEqual(["tok-alice-SECRET"]);
	});

	test("[r] 강제 새로고침은 간격을 무시하되 쿨다운 안에서는 부르지 않는다", async () => {
		const cachePath = tempCache();
		const { fetchImpl, calls } = fakeFetch();
		await collectShared(AUTH, { fetchImpl, now: NOW, cachePath });
		calls.length = 0;
		await collectShared(AUTH, { fetchImpl, now: NOW + RATE_LIMIT_COOLDOWN_MS - 1, cachePath, force: true });
		expect(calls).toEqual([]);
		await collectShared(AUTH, { fetchImpl, now: NOW + RATE_LIMIT_COOLDOWN_MS, cachePath });
		expect(calls).toEqual([]);
		await collectShared(AUTH, { fetchImpl, now: NOW + RATE_LIMIT_COOLDOWN_MS, cachePath, force: true });
		expect(calls.sort()).toEqual(["tok-alice-SECRET", "tok-bob-SECRET"]);
	});

	test("캐시 파일에는 토큰이 없고 주인만 읽을 수 있다 (0600)", async () => {
		const cachePath = tempCache();
		await collectShared(AUTH, { fetchImpl: fakeFetch().fetchImpl, now: NOW, cachePath });
		const text = readFileSync(cachePath, "utf8");
		expect(text).toContain("alice");
		for (const secret of ["SECRET", "sentinel-access", "sentinel-refresh"]) expect(text).not.toContain(secret);
		expect(statSync(cachePath).mode & 0o777).toBe(0o600);
	});

	test("낡은 잠금(주인이 오래전에 잡은 것)은 풀고 조회한다", async () => {
		const cachePath = tempCache();
		writeFileSync(`${cachePath}.lock`, JSON.stringify({ pid: process.pid, at: NOW - LOCK_STALE_MS - 1, token: "old" }));
		const { fetchImpl, calls } = fakeFetch();
		const rows = await collectShared(AUTH, { fetchImpl, now: NOW, cachePath, sleep: () => Promise.reject(new Error("must not wait on a stale lock")) });
		expect(calls.length).toBe(2);
		expect(rows.every((row) => row.status === "ok")).toBe(true);
	});

	test("조회 간격은 OMO_USAGE_REFRESH_SECONDS로 바꾸되 쿨다운보다 짧게는 못 잡는다", () => {
		expect(refreshIntervalMs({})).toBe(DEFAULT_REFRESH_MS);
		expect(refreshIntervalMs({ OMO_USAGE_REFRESH_SECONDS: "1800" })).toBe(1_800_000);
		expect(refreshIntervalMs({ OMO_USAGE_REFRESH_SECONDS: "10" })).toBe(RATE_LIMIT_COOLDOWN_MS);
		expect(refreshIntervalMs({ OMO_USAGE_REFRESH_SECONDS: "garbage" })).toBe(DEFAULT_REFRESH_MS);
	});
});
