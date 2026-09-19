import { describe, expect, test } from "bun:test";
import { lastUsedBySlot } from "../src/pool.ts";

/** 2026-09-19 실제 credential-pool-state.json 모양 (슬롯 이름만 익명화). */
const POOL = {
	schemaVersion: 1,
	installationKey: "c841b1af",
	providers: {
		"claude-sdk-oauth": {
			lanes: {
				stored: {
					slots: {
						carol: { stateVersion: 1316, failureCount: 6, lastSuccessAt: 1789821846600, credentialRevision: "22f2d705" },
						alice: { stateVersion: 469, failureCount: 5, lastSuccessAt: 1789820626992, credentialRevision: "9353fb98" },
						bob: {
							stateVersion: 1560,
							failureCount: 8,
							lastSuccessAt: 1789710205213,
							lease: { id: "9fa673f1", expiresAt: 1789821805435 },
							blockedUntil: 1789794312290,
							blockReason: "rate_limit",
						},
						k2IzPrMevJwxnwMTrgQ4: { stateVersion: 18, blockedUntil: 1789569115468, blockReason: "rate_limit", failureCount: 4 },
					},
				},
			},
		},
		"openai-codex": { lanes: { stored: { slots: {} } } },
	},
};

describe("lastUsedBySlot", () => {
	test("성공 시각이 있는 슬롯만 provider/slot 키로 편다", () => {
		const map = lastUsedBySlot(POOL);
		expect(map.get("claude-sdk-oauth/carol")).toBe(1789821846600);
		expect(map.get("claude-sdk-oauth/alice")).toBe(1789820626992);
		expect(map.get("claude-sdk-oauth/bob")).toBe(1789710205213);
		expect(map.get("claude-sdk-oauth/k2IzPrMevJwxnwMTrgQ4")).toBeUndefined();
		expect(map.size).toBe(3);
	});

	test("lane이 여럿이면 가장 최근 성공 시각을 쓴다", () => {
		const map = lastUsedBySlot({
			providers: {
				p: { lanes: { stored: { slots: { s: { lastSuccessAt: 100 } } }, env: { slots: { s: { lastSuccessAt: 300 } } } } },
			},
		});
		expect(map.get("p/s")).toBe(300);
	});

	test("빈/깨진 입력에서 시각을 지어내지 않는다", () => {
		for (const input of [null, undefined, "garbage", 42, [], {}, { providers: null }, { providers: { p: {} } }, { providers: { p: { lanes: { stored: {} } } } }]) {
			expect(lastUsedBySlot(input).size).toBe(0);
		}
	});

	test("숫자가 아닌 lastSuccessAt은 버린다", () => {
		const map = lastUsedBySlot({
			providers: { p: { lanes: { stored: { slots: { a: { lastSuccessAt: "100" }, b: { lastSuccessAt: Number.NaN }, c: { lastSuccessAt: 0 }, d: { lastSuccessAt: 7 } } } } } },
		});
		expect([...map.keys()]).toEqual(["p/d"]);
	});
});
