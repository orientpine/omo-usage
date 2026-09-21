import { describe, expect, test } from "bun:test";
import { buildRoster } from "../src/auth.ts";

const NOW = Date.UTC(2026, 8, 17, 7, 0, 0);
const future = NOW + 3_600_000;
const past = NOW - 3_600_000;

const AUTH = {
	google: { type: "api", key: "sk-fake" },
	"openai-codex": {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: future,
		accountId: "acc",
		accounts: [
			{ name: "default", displayName: "ann", access: "a", refresh: "r", expires: future, source: "login" },
			{ name: "login-2", displayName: "dana", access: "a", refresh: "r", expires: future, source: "login" },
		],
	},
	"claude-sdk-oauth": {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: future,
		accounts: [
			{ name: "default", displayName: "alice", access: "a", refresh: "r", expires: future, source: "login" },
			{ name: "bob", displayName: null, access: "a", refresh: "r", expires: future, source: "login" },
			{ name: "carol", displayName: null, access: "a", refresh: "r", expires: past, source: "login" },
		],
	},
	xai: { type: "oauth", access: "a", refresh: "r", expires: future },
	"kimi-coding": { type: "oauth", access: "a", refresh: "r", expires: future },
};

describe("buildRoster", () => {
	test("로그인된 모든 계정을 한 줄씩 만든다", () => {
		const rows = buildRoster(AUTH, NOW);
		expect(rows.map((r) => `${r.provider}/${r.slot}`)).toEqual([
			"claude-sdk-oauth/default",
			"claude-sdk-oauth/bob",
			"claude-sdk-oauth/carol",
			"openai-codex/default",
			"openai-codex/login-2",
			"xai/default",
			"kimi-coding/default",
			"google/default",
		]);
	});

	test("displayName이 있으면 라벨로 쓰고 없으면 슬롯 이름을 쓴다", () => {
		const rows = buildRoster(AUTH, NOW);
		expect(rows.find((r) => r.slot === "default" && r.provider === "claude-sdk-oauth")?.label).toBe("alice");
		expect(rows.find((r) => r.slot === "bob")?.label).toBe("bob");
		expect(rows.find((r) => r.slot === "login-2")?.label).toBe("dana");
	});

	test("만료된 토큰은 expired, 유효한 토큰은 loading으로 시작한다", () => {
		const rows = buildRoster(AUTH, NOW);
		expect(rows.find((r) => r.slot === "carol")?.status).toBe("expired");
		expect(rows.find((r) => r.slot === "bob")?.status).toBe("loading");
	});

	test("usage API가 없는 provider는 unsupported로 표시하고 숫자를 지어내지 않는다", () => {
		const rows = buildRoster(AUTH, NOW);
		const google = rows.find((r) => r.provider === "google");
		expect(google?.status).toBe("unsupported");
		expect(google?.windows).toEqual([]);
		expect(google?.expiresAt).toBeNull();
	});

	test("xai는 accounts 배열 없는 단일 OAuth 자격증명이라 default 슬롯 하나로 조회 대상이 된다", () => {
		const xai = buildRoster(AUTH, NOW).find((r) => r.provider === "xai");
		expect(xai?.slot).toBe("default");
		expect(xai?.status).toBe("loading");
		expect(xai?.expiresAt).toBe(future);
	});

	test("accounts 배열이 없고 단일 자격증명만 있어도 한 줄을 만든다", () => {
		const rows = buildRoster({ "claude-sdk-oauth": { type: "oauth", access: "a", expires: future } }, NOW);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.slot).toBe("default");
		expect(rows[0]?.status).toBe("loading");
	});

	test("만료 사유는 blockReason으로 갈린다 — auth_error만 /login 안내, 나머지는 자동 갱신", () => {
		const rows = buildRoster(
			{
				"claude-sdk-oauth": {
					type: "oauth",
					access: "a",
					refresh: "r",
					expires: future,
					accounts: [
						{ name: "dead", access: "a", refresh: "r", expires: past, source: "login", blockReason: "auth_error" },
						{ name: "limited", access: "a", refresh: "r", expires: past, source: "login", blockedUntil: past, blockReason: "rate_limit" },
						{ name: "idle", access: "a", refresh: "r", expires: past, source: "login" },
					],
				},
			},
			NOW,
		);
		const detail = (slot: string) => rows.find((r) => r.slot === slot)?.detail ?? "";
		expect(rows.map((r) => r.status)).toEqual(["expired", "expired", "expired"]);
		expect(detail("dead")).toContain("/login claude-sdk-oauth");
		expect(detail("limited")).not.toContain("/login");
		expect(detail("idle")).not.toContain("/login");
	});

	test("auth.json의 pinned 슬롯만 pinned 표시를 받는다", () => {
		const rows = buildRoster(
			{
				"claude-sdk-oauth": {
					type: "oauth",
					access: "a",
					refresh: "r",
					expires: future,
					pinned: "second",
					accounts: [
						{ name: "first", access: "a", refresh: "r", expires: future, source: "login" },
						{ name: "second", access: "a", refresh: "r", expires: future, source: "login" },
					],
				},
			},
			NOW,
		);
		expect(rows.find((r) => r.slot === "second")?.pinned).toBe(true);
		expect(rows.find((r) => r.slot === "first")?.pinned).toBeUndefined();
	});

	test("빈 auth.json이면 빈 배열", () => {
		expect(buildRoster({}, NOW)).toEqual([]);
		expect(buildRoster(null, NOW)).toEqual([]);
	});
});
