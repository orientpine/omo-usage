import { describe, expect, spyOn, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFooterExtension, createUsagePoller, renderFooter, sessionSlot, type ExtensionContextLike } from "../src/footer.ts";
import { displayWidth } from "../src/render.ts";
import type { AccountRow, UsageWindow } from "../src/types.ts";

const NOW = Date.UTC(2026, 9, 1, 4, 0, 0);
const ESC = /\u001B\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ESC, "");

function win(label: string, remainingPercent: number, resetsAt: number | null = null): UsageWindow {
	return { label, kind: label === "5h" ? "session" : label === "7d" ? "weekly" : "scoped", remainingPercent, resetsAt };
}

function row(over: Partial<AccountRow>): AccountRow {
	return { provider: "anthropic-subscription", slot: "default", label: "default", status: "ok", detail: null, plan: null, expiresAt: null, windows: [], ...over };
}

// 실제 화면과 같은 구성: Claude 3계정(하나는 자동 갱신될 만료), Codex 한 계정이 빨강
const ROWS: AccountRow[] = [
	row({ slot: "orientpine", label: "orientpine", windows: [win("5h", 97), win("7d", 76, NOW + 28 * 3_600_000), win("Fable", 97)] }),
	row({ slot: "cbaekdong", label: "cbaekdong", status: "expired", detail: "senpi refreshes it on next use · no re-login" }),
	row({ slot: "baekdongc", label: "baekdongc", windows: [win("5h", 99), win("7d", 85), win("Fable", 96)] }),
	row({ provider: "chatgpt-subscription", slot: "dxlab", label: "dxlab", windows: [win("5h", 100), win("7d", 4)] }),
	row({ provider: "google", slot: "default", label: "google", status: "unsupported", detail: "no usage API" }),
];
const FOCUS = { provider: "anthropic-subscription", slot: "orientpine" };
const at = (cols: number) => strip(renderFooter(ROWS, FOCUS, cols, NOW));

describe("renderFooter", () => {
	test("넓으면 ① 막는 창 막대 + ② 나머지 계정 칸 + ③ 다른 provider 예외를 한 줄에 담는다", () => {
		const line = at(120);
		expect(line).toMatch(/^Claude·orientpine ▕[█░]{14}▏ 76% 7d · resets \d\d\/\d\d \d\d:\d\d │ pool ✗▇ │ ⚠ Codex·dxlab 7d 4%$/);
	});

	test("폭이 줄면 ③ → ② → 리셋 시각 → 막대 길이 순으로 덜고, 마지막엔 …로 자른다", () => {
		expect(at(80)).toMatch(/· resets .* │ pool ✗▇$/);
		expect(at(70)).toMatch(/▏ 76% 7d · resets \d\d\/\d\d \d\d:\d\d$/);
		expect(at(50)).toMatch(/^Claude·orientpine ▕[█░]{14}▏ 76% 7d$/);
		expect(at(40)).toMatch(/^Claude·orientpine ▕[█░]{13}▏ 76% 7d$/);
		expect(at(30).endsWith("…")).toBe(true);
		for (let cols = 10; cols <= 140; cols++) {
			const line = renderFooter(ROWS, FOCUS, cols, NOW);
			expect(displayWidth(strip(line))).toBeLessThanOrEqual(cols);
			// 덜어내는 순서가 지켜진다: 예외가 있으면 pool도, pool이 있으면 리셋도 있다
			const plain = strip(line);
			if (plain.includes("⚠")) expect(plain).toContain("pool");
			if (plain.includes("pool")) expect(plain).toContain("resets");
		}
	});

	test("레벨 색은 막는 창 기준이고 빨강 예외는 빨강으로 칠한다", () => {
		const line = renderFooter(ROWS, FOCUS, 120, NOW);
		expect(line).toContain("\u001B[38;2;74;222;128mClaude·orientpine ▕");
		expect(line).toContain("\u001B[38;2;248;113;113m⚠ Codex·dxlab 7d 4%");
	});

	test("현재 슬롯을 모르면 단정하지 않고 pool에 모든 계정을 보인다", () => {
		expect(strip(renderFooter(ROWS, { provider: "anthropic-subscription", slot: null }, 120, NOW))).toBe("Claude │ pool ▇✗▇ │ ⚠ Codex·dxlab 7d 4%");
	});

	test("지금 계정이 막대 없이 만료면 사유를 적고, 429로 값을 붙든 중이어도 재시도 대신 평소처럼 리셋 시각을 보인다", () => {
		expect(at(120)).not.toContain("retry");
		expect(strip(renderFooter(ROWS, { provider: "anthropic-subscription", slot: "cbaekdong" }, 120, NOW))).toMatch(/^Claude·cbaekdong expired │ pool ▇▇/);
		const limited = ROWS.map((r) => (r.slot === "orientpine" ? { ...r, retryAt: NOW + 120_000 } : r));
		expect(strip(renderFooter(limited, FOCUS, 120, NOW))).toBe(at(120));
	});

	test("지금 계정 값이 30분보다 오래됐으면 막대를 회색으로 그리고 리셋 시각 대신 stale을 단다", () => {
		const stale = ROWS.map((r) => (r.slot === "orientpine" ? { ...r, fetchedAt: NOW - 9 * 3_600_000 } : r));
		const line = renderFooter(stale, FOCUS, 120, NOW);
		expect(strip(line)).toMatch(/^Claude·orientpine ▕[█░]{14}▏ 76% 7d · stale │ pool ✗▇ │ ⚠ Codex·dxlab 7d 4%$/);
		expect(line).toContain("\u001B[90mClaude·orientpine ▕");
		const fresh = ROWS.map((r) => (r.slot === "orientpine" ? { ...r, fetchedAt: NOW - 5 * 60_000 } : r));
		expect(strip(renderFooter(fresh, FOCUS, 120, NOW))).toBe(at(120));
	});

	test("조회할 계정이 없는 provider면 줄을 그리지 않는다", () => {
		expect(renderFooter(ROWS, { provider: "google", slot: "default" }, 120, NOW)).toBe("");
		expect(renderFooter(ROWS, { provider: "openrouter", slot: null }, 120, NOW)).toBe("");
	});
});

const future = NOW + 3_600_000;
const AUTH = {
	"anthropic-subscription": {
		type: "oauth",
		access: "a",
		refresh: "r",
		expires: future,
		accounts: [
			{ name: "alice", displayName: "alice", access: "tok-alice", refresh: "r", expires: future },
			{ name: "bob", displayName: "bob", access: "tok-bob", refresh: "r", expires: future },
		],
	},
};
const OK_BODY = { five_hour: { utilization: 16, resets_at: "2026-10-01T09:00:00Z" }, seven_day: { utilization: 44, resets_at: "2026-10-05T00:00:00Z" } };

describe("sessionSlot", () => {
	const pool = (names: string[], pinned?: string) => ({ type: "oauth", accounts: names.map((name) => ({ name, access: `tok-${name}` })), ...(pinned ? { pinned } : {}) });

	test("고정 슬롯이 있으면 그것이고, 없는 이름을 고정했으면 무시한다", () => {
		expect(sessionSlot(pool(["a", "b", "c"], "b"), "s1")).toBe("b");
		expect(["a", "b", "c"]).toContain(sessionSlot(pool(["a", "b", "c"], "gone"), "s1")!);
	});

	test("세션으로 고른 슬롯은 계정 순서와 무관하고 같은 세션에선 늘 같다 (HRW)", () => {
		for (const id of ["s1", "s2", "s3", "s4", "s5", "s6"]) {
			const winner = sessionSlot(pool(["a", "b", "c"]), id)!;
			expect(["a", "b", "c"]).toContain(winner);
			expect(sessionSlot(pool(["c", "a", "b"]), id)!).toBe(winner);
			expect(sessionSlot(pool(["b", "c", "a"]), id)!).toBe(winner);
		}
	});

	test("세션마다 다른 슬롯이 걸린다 (한 슬롯만 고르지 않는다)", () => {
		const winners = new Set(Array.from({ length: 60 }, (_, i) => sessionSlot(pool(["a", "b", "c"]), `session-${i}`)!));
		expect(winners).toEqual(new Set(["a", "b", "c"]));
	});

	test("accounts 없는 평평한 자격증명은 default, 자격증명이 없으면 null, 세션 id가 없으면 단정하지 않는다", () => {
		expect(sessionSlot({ type: "oauth", access: "x" }, "s1")).toBe("default");
		expect(sessionSlot(undefined, "s1")).toBeNull();
		expect(sessionSlot(pool(["a", "b"]), null)).toBeNull();
		expect(sessionSlot(pool(["a", "b"], "a"), null)).toBe("a");
	});
});

describe("createUsagePoller", () => {
	test("reads only the shared cache, including on periodic refresh", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "omo-usage-test-")), "usage.json");
		await Bun.write(path, JSON.stringify({ version: 1, accounts: { "anthropic-subscription/orientpine": { checkedAt: NOW, row: ROWS[0] } } }));
		const timers: (() => void)[] = [];
		const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(Response.json(OK_BODY));
		const poller = createUsagePoller(() => {}, {
			readAuth: async () => ({ "anthropic-subscription": { accounts: [{ name: "orientpine", access: "fake", expires: future }] } }),
			now: () => NOW,
			cachePath: path,
			setTimer: (fn) => timers.push(fn),
			clearTimer: () => {},
		});
		try {
			poller.start();
			await poller.refresh();
			expect(poller.rows()[0]?.windows).toEqual(ROWS[0]?.windows ?? []);
			timers[0]?.();
			await poller.refresh();
			expect(poller.rows()[0]?.slot).toBe("orientpine");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			poller.stop();
			fetchSpy.mockRestore();
		}
	});

	test("omits deleted cache accounts from pool cells and exceptions", async () => {
		const path = join(mkdtempSync(join(tmpdir(), "omo-usage-test-")), "usage.json");
		const cached = [
			row({ slot: "alice", windows: [win("7d", 56)] }),
			row({ slot: "deleted-slot", windows: [win("7d", 3)] }),
		];
		await Bun.write(path, JSON.stringify({ version: 1, accounts: Object.fromEntries(cached.map((row) => [
			`${row.provider}/${row.slot}`, { checkedAt: NOW, row },
		])) }));
		const poller = createUsagePoller(() => {}, {
			readAuth: async () => ({ "anthropic-subscription": { accounts: [AUTH["anthropic-subscription"].accounts[0]] } }),
			now: () => NOW,
			cachePath: path,
		});
		await poller.refresh();
		expect(poller.rows().map((row) => row.slot)).toEqual(["alice"]);
		expect(strip(renderFooter(poller.rows(), { provider: "anthropic-subscription", slot: null }, 120, NOW))).toBe("Claude │ pool ▅");
		const codex = row({ provider: "chatgpt-subscription", windows: [win("7d", 80)] });
		expect(strip(renderFooter([...poller.rows(), codex], { provider: codex.provider, slot: null }, 120, NOW))).toBe("Codex │ pool ▇");
	});
});

describe("createFooterExtension", () => {
	type SetWidget = NonNullable<ExtensionContextLike["ui"]["setWidget"]>;
	interface WidgetCall {
		readonly key: string;
		readonly content: string[] | undefined;
		readonly placement: string | undefined;
	}

	function setup(setWidget: SetWidget | undefined, cols = { value: 120 }) {
		const handlers = new Map<string, (event: unknown, ctx: ExtensionContextLike) => unknown>();
		let resize: () => void = () => {};
		let unsubscribed = false;
		let authReads = 0;
		let timers = 0;

		const path = join(mkdtempSync(join(tmpdir(), "omo-usage-test-")), "usage.json");
		writeFileSync(path, JSON.stringify({ version: 1, accounts: Object.fromEntries(["alice", "bob"].map((slot) => [`anthropic-subscription/${slot}`, { checkedAt: NOW, row: row({ slot, label: slot, windows: [win("5h", 84), win("7d", 56, NOW + 86400000)] }) }])) }));
		const extension = createFooterExtension({
			readAuth: async () => {
				authReads++;
				return AUTH;
			},
			cachePath: path,
			now: () => NOW,
			setTimer: () => ++timers,
			clearTimer: () => {},
			columns: () => cols.value,
			onResize: (listener) => {
				resize = listener;
				return () => {
					unsubscribed = true;
				};
			},
		});
		extension({ on: (event, handler) => void handlers.set(event, handler) });
		const ctx: ExtensionContextLike = {
			hasUI: true,
			model: { provider: "anthropic-subscription", id: "claude-fable-5-1" },
			modelRegistry: { authStorage: { get: (provider) => (provider === "anthropic-subscription" ? { ...AUTH["anthropic-subscription"], pinned: "bob" } : undefined) } },
			sessionManager: { getSessionId: () => "session-1" },
			ui: { setWidget, notify: () => {} },
		};
		return { handlers, ctx, resize: () => resize(), unsubscribed: () => unsubscribed, authReads: () => authReads, timers: () => timers };
	}

	/** 조회가 끝나 첫 줄이 그려지는 그 setWidget 호출 자체를 기다린다 (시간 대기 없이). */
	function recorder() {
		const calls: WidgetCall[] = [];
		let drawn: () => void = () => {};
		const firstDraw = new Promise<void>((resolve) => {
			drawn = resolve;
		});
		const setWidget: SetWidget = (key, content, options) => {
			calls.push({ key, content, placement: options?.placement });
			if (content !== undefined) drawn();
		};
		const waitFirstDraw = () => Promise.race([firstDraw, new Promise<never>((_, reject) => setTimeout(() => reject(new Error("widget was never drawn")), 2_000))]);
		return { calls, setWidget, waitFirstDraw };
	}

	test("편집기 아래(belowEditor) 위젯으로 지금 슬롯 기준 한 줄을 그리고, 폭이 바뀌면 다시 맞추며, shutdown이면 지운다", async () => {
		const cols = { value: 120 };
		const widget = recorder();
		const { handlers, ctx, resize, unsubscribed } = setup(widget.setWidget, cols);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await widget.waitFirstDraw();

		const first = widget.calls.find((call) => call.content !== undefined);
		expect(first?.key).toBe("omo-usage");
		expect(first?.placement).toBe("belowEditor");
		expect(first?.content?.length).toBe(1);
		expect(strip(first?.content?.[0] ?? "")).toMatch(/^Claude·bob ▕[█░]{14}▏ 56% 7d · resets .* │ pool ▅$/);

		cols.value = 50;
		resize();
		const narrow = strip(widget.calls.at(-1)?.content?.[0] ?? "");
		expect(narrow).toMatch(/^Claude·bob ▕[█░]{14}▏ 56% 7d$/);
		// senpi는 위젯 줄 좌우에 1칸씩 여백을 두므로 터미널 50칸이면 줄은 48칸 안에 들어와야 넘어가지 않는다
		expect(displayWidth(narrow)).toBeLessThanOrEqual(48);

		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		expect(widget.calls.at(-1)?.content).toBeUndefined();
		expect(unsubscribed()).toBe(true);
	});

	test("setWidget이 없으면 아무것도 그리지 않고 조회도 하지 않는다", async () => {
		const { handlers, ctx, authReads, timers } = setup(undefined);
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await handlers.get("model_select")?.({}, ctx);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		expect(authReads()).toBe(0);
		expect(timers()).toBe(0);
	});

	test("setWidget이 던지면 조용히 빠진다: 예외를 올리지 않고 다시 그리지도 않는다", async () => {
		let calls = 0;
		let thrown: () => void = () => {};
		const threw = new Promise<void>((resolve) => {
			thrown = resolve;
		});
		const { handlers, ctx, resize } = setup(() => {
			calls++;
			thrown();
			throw new Error("widget host gone");
		});
		await handlers.get("session_start")?.({ reason: "startup" }, ctx);
		await Promise.race([threw, new Promise((_, reject) => setTimeout(() => reject(new Error("setWidget was never called")), 2_000))]);

		resize();
		await handlers.get("model_select")?.({}, ctx);
		await handlers.get("session_shutdown")?.({ reason: "quit" }, ctx);
		expect(calls).toBe(1);
	});
});
