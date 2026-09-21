import { describe, expect, test } from "bun:test";
import { parseClaudeUsage, parseCodexUsage, parseKimiUsage, parseXaiUsage } from "../src/parse.ts";

/** 2026-09-18 cli-chat-proxy 실제 응답 (SuperGrok Plus, 통합 주간 풀) */
const XAI_BODY = {
	config: {
		currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-15T02:26:42.804043+00:00", end: "2026-09-22T02:26:42.804043+00:00" },
		creditUsagePercent: 13.0,
		onDemandCap: { val: 0 },
		onDemandUsed: { val: 0 },
		productUsage: [
			{ product: "GrokBuild", usagePercent: 12.0 },
			{ product: "GrokImagine", usagePercent: 1.0 },
		],
		isUnifiedBillingUser: true,
		prepaidBalance: { val: 0 },
		topUpMethod: "TOP_UP_METHOD_SAVED_PAYMENT_METHOD",
		billingPeriodStart: "2026-09-15T02:26:42.804043+00:00",
		billingPeriodEnd: "2026-09-22T02:26:42.804043+00:00",
	},
};
const WEEK = { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-09-15T02:26:42Z", end: "2026-09-22T02:26:42Z" };

describe("parseClaudeUsage", () => {
	test("five_hour / seven_day를 남은 비율로 바꾼다", () => {
		const w = parseClaudeUsage({
			five_hour: { utilization: 49, resets_at: "2026-09-17T11:09:59.940318+00:00" },
			seven_day: { utilization: 89, resets_at: "2026-09-18T17:59:59.940337+00:00" },
		});
		expect(w.find((x) => x.label === "5h")).toEqual({
			label: "5h",
			kind: "session",
			remainingPercent: 51,
			resetsAt: Date.parse("2026-09-17T11:09:59.940318+00:00"),
		});
		expect(w.find((x) => x.label === "7d")?.remainingPercent).toBe(11);
	});

	test("limits 배열의 weekly_scoped 모델별 한도를 별도 창으로 만든다", () => {
		const w = parseClaudeUsage({
			five_hour: { utilization: 49, resets_at: null },
			limits: [
				{ kind: "session", group: "session", percent: 49, resets_at: null, scope: null },
				{ kind: "weekly_all", group: "weekly", percent: 89, resets_at: null, scope: null },
				{ kind: "weekly_scoped", group: "weekly", percent: 81, resets_at: "2026-09-18T17:59:59+00:00", scope: { model: { id: null, display_name: "Fable" } } },
			],
		});
		const fable = w.find((x) => x.label === "Fable");
		expect(fable?.kind).toBe("scoped");
		expect(fable?.remainingPercent).toBe(19);
	});

	test("빈/깨진 응답에서 숫자를 지어내지 않는다", () => {
		expect(parseClaudeUsage({})).toEqual([]);
		expect(parseClaudeUsage(null)).toEqual([]);
		expect(parseClaudeUsage("nope")).toEqual([]);
		expect(parseClaudeUsage({ five_hour: null })).toEqual([]);
		expect(parseClaudeUsage({ five_hour: { utilization: null } })).toEqual([]);
		expect(parseClaudeUsage({ five_hour: { utilization: "49" } })).toEqual([]);
		expect(parseClaudeUsage({ five_hour: { utilization: Number.NaN } })).toEqual([]);
		expect(parseClaudeUsage({ type: "error", error: { message: "unauthorized" } })).toEqual([]);
	});

	test("resets_at이 깨졌으면 resetsAt은 null이지만 비율은 살린다", () => {
		const w = parseClaudeUsage({ five_hour: { utilization: 10, resets_at: "garbage" } });
		expect(w[0]?.remainingPercent).toBe(90);
		expect(w[0]?.resetsAt).toBeNull();
	});

	test("범위를 벗어난 utilization은 0..100으로 자른다", () => {
		expect(parseClaudeUsage({ five_hour: { utilization: 140 } })[0]?.remainingPercent).toBe(0);
		expect(parseClaudeUsage({ five_hour: { utilization: -20 } })[0]?.remainingPercent).toBe(100);
	});
});

describe("parseCodexUsage", () => {
	test("primary/secondary 위치가 아니라 limit_window_seconds로 창을 구분한다", () => {
		const ann = parseCodexUsage({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 57, limit_window_seconds: 604800, reset_at: 1790081482 },
				secondary_window: null,
			},
		});
		expect(ann.plan).toBe("pro");
		expect(ann.windows).toHaveLength(1);
		expect(ann.windows[0]).toEqual({ label: "7d", kind: "weekly", remainingPercent: 43, resetsAt: 1790081482000 });

		const dana = parseCodexUsage({
			plan_type: "team",
			rate_limit: {
				primary_window: { used_percent: 100, limit_window_seconds: 18000, reset_at: 1789643871 },
				secondary_window: { used_percent: 48, limit_window_seconds: 604800, reset_at: 1790081482 },
			},
		});
		expect(dana.windows.map((w) => w.label)).toEqual(["5h", "7d"]);
		expect(dana.windows[0]?.remainingPercent).toBe(0);
		expect(dana.windows[1]?.remainingPercent).toBe(52);
	});

	test("모르는 길이의 창도 버리지 않고 기간 라벨로 보여준다", () => {
		const r = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 25, limit_window_seconds: 3600 } } });
		expect(r.windows[0]?.label).toBe("1h");
		expect(r.windows[0]?.kind).toBe("other");
		expect(r.windows[0]?.remainingPercent).toBe(75);
	});

	test("빈/깨진 응답에서 숫자를 지어내지 않는다", () => {
		expect(parseCodexUsage({})).toEqual({ windows: [], plan: null });
		expect(parseCodexUsage(null)).toEqual({ windows: [], plan: null });
		expect(parseCodexUsage({ detail: "Unauthorized" })).toEqual({ windows: [], plan: null });
		expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: "57", limit_window_seconds: 604800 } } }).windows).toEqual([]);
		expect(parseCodexUsage({ rate_limit: { primary_window: { used_percent: 57 } } }).windows).toEqual([]);
	});

	test("reset_at이 없으면 reset_after_seconds로 계산한다", () => {
		const now = 1789629000000;
		const r = parseCodexUsage({ rate_limit: { primary_window: { used_percent: 10, limit_window_seconds: 18000, reset_after_seconds: 600 } } }, now);
		expect(r.windows[0]?.resetsAt).toBe(now + 600_000);
	});
});

describe("parseXaiUsage", () => {
	test("creditUsagePercent는 7d 창 하나가 되고 productUsage는 내역 문구가 된다", () => {
		const r = parseXaiUsage(XAI_BODY);
		expect(r.windows).toEqual([{ label: "7d", kind: "weekly", remainingPercent: 87, resetsAt: Date.parse("2026-09-22T02:26:42.804043+00:00") }]);
		expect(r.note).toContain("GrokBuild 12%");
		expect(r.note).toContain("GrokImagine 1%");
	});

	test("proto3 생략: currentPeriod가 있는데 creditUsagePercent 키가 없으면 0으로 읽는다", () => {
		const r = parseXaiUsage({ config: { currentPeriod: WEEK, productUsage: [{ product: "GrokBuild" }] } });
		expect(r.windows[0]?.remainingPercent).toBe(100);
		expect(r.note).toContain("GrokBuild 0%");
	});

	test("빈/깨진 응답에서 숫자를 지어내지 않는다", () => {
		const empty = { windows: [], note: null };
		expect(parseXaiUsage({})).toEqual(empty);
		expect(parseXaiUsage(null)).toEqual(empty);
		expect(parseXaiUsage({ config: null })).toEqual(empty);
		// currentPeriod가 없으면 크레딧 응답이 아니다 — 키 생략을 0으로 읽지 않는다
		expect(parseXaiUsage({ config: {} })).toEqual(empty);
		expect(parseXaiUsage({ error: "unauthorized" })).toEqual(empty);
		expect(parseXaiUsage({ config: { currentPeriod: WEEK, creditUsagePercent: "13" } }).windows).toEqual([]);
		expect(parseXaiUsage({ config: { currentPeriod: WEEK, creditUsagePercent: 13, productUsage: [{ product: "GrokBuild", usagePercent: "12" }] } }).note).toBeNull();
	});

	test("주간이 아닌 기간은 start/end 길이로 라벨을 만든다", () => {
		const r = parseXaiUsage({ config: { currentPeriod: { type: "USAGE_PERIOD_TYPE_MONTHLY", start: "2026-09-01T00:00:00Z", end: "2026-10-01T00:00:00Z" }, creditUsagePercent: 40 } });
		expect(r.windows).toEqual([{ label: "30d", kind: "other", remainingPercent: 60, resetsAt: Date.parse("2026-10-01T00:00:00Z") }]);
	});
});

/** 2026-09-21 api.kimi.com 실제 응답 형태 (Kimi Code 구독) — proto3 JSON이라 int64가 문자열이다 */
const KIMI_BODY = {
	usage: { limit: "100", used: "7", remaining: "93", resetTime: "2026-09-27T16:35:17.353107Z" },
	limits: [
		{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "100", used: "2", remaining: "98", resetTime: "2026-09-21T09:35:17.353107Z" } },
	],
	usages: { limit_5h: { used_ratio: 0, reset_time: "2026-09-21T09:35:17Z" }, limit_7d: { used_ratio: 0, reset_time: "2026-09-27T16:35:17Z" } },
};

describe("parseKimiUsage", () => {
	test("limits[]의 롤링 창과 usage의 주간 쿼터를 남은 비율로 바꾼다", () => {
		const w = parseKimiUsage(KIMI_BODY);
		expect(w.map((x) => x.label)).toEqual(["5h", "7d"]);
		expect(w[0]).toEqual({ label: "5h", kind: "session", remainingPercent: 98, resetsAt: Date.parse("2026-09-21T09:35:17.353107Z") });
		expect(w[1]).toEqual({ label: "7d", kind: "weekly", remainingPercent: 93, resetsAt: Date.parse("2026-09-27T16:35:17.353107Z") });
	});

	test("used_ratio는 뭉개진 값이라 쓰지 않고 카운트만 읽는다", () => {
		// KIMI_BODY의 used_ratio는 0이지만 실제 사용은 7/100 — 100%로 읽으면 틀린다
		expect(parseKimiUsage(KIMI_BODY).find((x) => x.label === "7d")?.remainingPercent).toBe(93);
	});

	test("remaining이 없으면 limit-used로 계산한다", () => {
		const w = parseKimiUsage({ usage: { limit: "100", used: "30", resetTime: "2026-09-27T00:00:00Z" } });
		expect(w[0]?.remainingPercent).toBe(70);
	});

	test("빈/깨진 응답에서 숫자를 지어내지 않는다", () => {
		expect(parseKimiUsage({})).toEqual([]);
		expect(parseKimiUsage(null)).toEqual([]);
		expect(parseKimiUsage({ detail: "Unauthorized" })).toEqual([]);
		expect(parseKimiUsage({ usage: { limit: "0", remaining: "0" } })).toEqual([]);
		expect(parseKimiUsage({ usage: { remaining: "93" } })).toEqual([]);
		expect(parseKimiUsage({ limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_UNKNOWN" }, detail: { limit: "100", remaining: "98" } }] })).toEqual([]);
		expect(parseKimiUsage({ limits: [{ window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" }, detail: { limit: "abc", remaining: "98" } }] })).toEqual([]);
	});

	test("limits[]의 창이 usage와 라벨이 겹치면 먼저 온 창 하나만 그린다", () => {
		const w = parseKimiUsage({
			usage: { limit: "100", remaining: "50", resetTime: "2026-09-27T00:00:00Z" },
			limits: [{ window: { duration: 7, timeUnit: "TIME_UNIT_DAY" }, detail: { limit: "100", remaining: "80", resetTime: "2026-09-27T00:00:00Z" } }],
		});
		expect(w).toEqual([{ label: "7d", kind: "weekly", remainingPercent: 80, resetsAt: Date.parse("2026-09-27T00:00:00Z") }]);
	});
});
