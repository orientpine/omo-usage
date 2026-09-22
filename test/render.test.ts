import { describe, expect, test } from "bun:test";
import { buildRoster } from "../src/auth.ts";
import { displayWidth, renderFrame, type AppState } from "../src/render.ts";
import type { AccountRow } from "../src/types.ts";

const NOW = Date.UTC(2026, 8, 17, 7, 30, 0);
const ESC = /\u001B\[[0-9;]*m/g;
const strip = (s: string) => s.replace(ESC, "");

function row(over: Partial<AccountRow>): AccountRow {
	return {
		provider: "claude-sdk-oauth",
		slot: "default",
		label: "alice",
		status: "ok",
		detail: null,
		plan: null,
		expiresAt: null,
		windows: [{ label: "5h", kind: "session", remainingPercent: 50, resetsAt: NOW + 3_600_000 }],
		...over,
	};
}

function state(rows: AccountRow[]): AppState {
	return { rows, updatedAt: NOW, refreshing: false, error: null, now: NOW };
}

describe("displayWidth", () => {
	test("한글/전각은 2칸, 아스키는 1칸, ANSI 색은 0칸", () => {
		expect(displayWidth("abc")).toBe(3);
		expect(displayWidth("한글")).toBe(4);
		expect(displayWidth("계정 usage")).toBe(10);
		expect(displayWidth("\u001B[32mok\u001B[0m")).toBe(2);
	});
});

describe("renderFrame", () => {
	test("모든 계정과 잔여 비율이 화면에 나온다", () => {
		const lines = renderFrame(
			state([
				row({}),
				row({ slot: "bob", label: "bob", windows: [{ label: "7d", kind: "weekly", remainingPercent: 69, resetsAt: null }] }),
				row({ provider: "openai-codex", slot: "login-2", label: "dana", plan: "team", windows: [{ label: "5h", kind: "session", remainingPercent: 0, resetsAt: NOW + 600_000 }] }),
			]),
			120,
		).map(strip);
		const text = lines.join("\n");
		expect(text).toContain("alice");
		expect(text).toContain("bob");
		expect(text).toContain("dana");
		expect(text).toContain("claude-sdk-oauth");
		expect(text).toContain("openai-codex");
		expect(text).toContain("50%");
		expect(text).toContain("69%");
		expect(text).toContain("0%");
		expect(text).toContain("team");
	});

	test("같은 provider 안의 계정은 빈 줄로 나뉘고, 첫 줄은 ● 마커·이어지는 줄은 │ 가이드를 단다", () => {
		const two = [
			{ label: "5h", kind: "session" as const, remainingPercent: 50, resetsAt: NOW + 3_600_000 },
			{ label: "7d", kind: "weekly" as const, remainingPercent: 30, resetsAt: null },
		];
		const lines = renderFrame(
			state([
				row({ windows: two }),
				row({ slot: "bob", label: "bob", windows: two }),
				row({ slot: "carol", label: "carol", windows: two }),
				row({ provider: "xai", slot: "default", label: "xai", status: "unsupported", detail: "no usage API", windows: [] }),
			]),
			120,
		).map(strip);

		const first = lines.findIndex((l) => l.startsWith("  ● alice"));
		const second = lines.findIndex((l) => l.startsWith("  ● bob"));
		const third = lines.findIndex((l) => l.startsWith("  ● carol"));
		expect(first).toBeGreaterThan(-1);
		expect(second).toBeGreaterThan(first);
		expect(third).toBeGreaterThan(second);

		// 계정 첫 줄 다음의 7d 줄은 │ 가이드로 시작한다
		expect(lines[first + 1]).toMatch(/^  │ +7d /);
		// 계정 사이에는 빈 줄이 하나 들어간다 (provider 헤더 바로 다음 첫 계정 앞에는 없다)
		expect(lines[second - 1]).toBe("");
		expect(lines[third - 1]).toBe("");
		expect(lines[first - 1]).toBe("  claude-sdk-oauth");
		// 창이 없는 계정(n/a)도 마커를 단다
		expect(lines.some((l) => l.startsWith("  ● xai"))).toBe(true);
	});

	test("어떤 줄도 터미널 폭을 넘지 않는다 (한글 라벨 포함)", () => {
		const lines = renderFrame(
			state([
				row({ label: "아주아주긴한글계정이름입니다정말로" }),
				row({ provider: "xai", slot: "default", label: "default", note: "breakdown GrokBuild 12% · GrokImagine 1% · 아주긴제품이름 0%" }),
				row({ provider: "google", slot: "default", label: "google", status: "unsupported", detail: "no usage API", windows: [] }),
			]),
			60,
		);
		for (const line of lines) expect(displayWidth(strip(line))).toBeLessThanOrEqual(60);
	});

	test("note가 있는 계정은 막대 아래 │ 가이드 줄에 내역을 dim으로 붙인다", () => {
		const lines = renderFrame(
			state([
				row({
					provider: "xai",
					label: "default",
					windows: [{ label: "7d", kind: "weekly", remainingPercent: 87, resetsAt: NOW + 86_400_000 }],
					note: "breakdown GrokBuild 12% · GrokImagine 1%",
				}),
			]),
			120,
		);
		const plain = lines.map(strip);
		const first = plain.findIndex((l) => l.startsWith("  ● default"));
		expect(plain[first]).toContain("87%");
		expect(plain[first + 1]).toMatch(/^  │ +breakdown GrokBuild 12% · GrokImagine 1%$/);
		expect(lines[first + 1]).toContain("\u001B[90mbreakdown");
	});

	test("unsupported/expired/error는 막대 대신 사유를 보여준다", () => {
		const lines = renderFrame(
			state([
				row({ provider: "xai", slot: "default", label: "xai", status: "unsupported", detail: "no usage API", windows: [] }),
				row({ slot: "carol", label: "carol", status: "expired", detail: "run /login claude-sdk-oauth in omo (name: carol)", windows: [] }),
				row({ slot: "broken", label: "broken", status: "error", detail: "HTTP 401", windows: [] }),
			]),
			100,
		).map(strip);
		const text = lines.join("\n");
		expect(text).toContain("no usage API");
		expect(text).toContain("/login claude-sdk-oauth");
		expect(text).toContain("HTTP 401");
		expect(text).not.toContain("%");
	});

	test("429로 이전 값을 유지한 계정은 막대 옆에 사유와 재시도 시각을 보여준다", () => {
		const retryAt = NOW + 120_000;
		const lines = renderFrame(
			state([
				row({ detail: "rate limited (HTTP 429)", retryAt }),
				row({ slot: "bob", label: "bob", status: "error", detail: "rate limited (HTTP 429)", retryAt, windows: [] }),
			]),
			120,
		).map(strip);
		const kept = lines.find((l) => l.includes("alice")) ?? "";
		const bare = lines.find((l) => l.includes("bob")) ?? "";
		const clock = new Date(retryAt);
		const stamp = `${String(clock.getHours()).padStart(2, "0")}:${String(clock.getMinutes()).padStart(2, "0")}`;
		expect(kept).toContain("50%");
		expect(kept).toContain(`rate limited (HTTP 429) · retry ${stamp}`);
		expect(bare).toContain(`error · rate limited (HTTP 429) · retry ${stamp}`);
	});

	test("최근 차감된 계정은 ▶ 마커와 '사용 중'을, 나머지는 '마지막 사용'을 단다", () => {
		const lines = renderFrame(
			state([
				row({ label: "carol", lastUsedAt: NOW - 30_000 }),
				row({ slot: "alice", label: "alice", lastUsedAt: NOW - 3 * 3_600_000 }),
				row({ slot: "idle", label: "idle" }),
				row({ slot: "gone", label: "gone", status: "expired", detail: "senpi refreshes it on next use · no re-login", windows: [], lastUsedAt: NOW - 14 * 3_600_000 }),
			]),
			120,
		).map(strip);

		const active = lines.findIndex((l) => l.startsWith("  ▶ carol"));
		expect(active).toBeGreaterThan(-1);
		expect(lines[active + 1]).toMatch(/^  │ +in use · just now$/);

		const stale = lines.findIndex((l) => l.startsWith("  ● alice"));
		expect(stale).toBeGreaterThan(-1);
		expect(lines[stale + 1]).toMatch(/^  │ +last used 3h ago$/);

		// lastUsedAt이 없으면 아무 말도 만들지 않는다
		const idle = lines.findIndex((l) => l.startsWith("  ● idle"));
		expect(lines[idle + 1] ?? "").not.toMatch(/in use|last used/);

		const gone = lines.findIndex((l) => l.startsWith("  ● gone"));
		expect(gone).toBeGreaterThan(-1);
		expect(lines[gone + 1]).toMatch(/^  │ +last used 14h ago$/);
	});

	test("사용 중 판정은 10분 경계로 갈린다", () => {
		const stampOn = (ago: number) =>
			renderFrame(state([row({ label: "x", lastUsedAt: NOW - ago })]), 120)
				.map(strip)
				.find((l) => /^  │ .*(in use|last used)/.test(l)) ?? "";
		expect(stampOn(9 * 60_000 + 59_000)).toContain("in use");
		expect(stampOn(10 * 60_000 + 1_000)).toContain("last used");
	});

	test("고정된 계정은 제목에 (고정)이 붙는다", () => {
		const text = renderFrame(state([row({ label: "carol", pinned: true })]), 120).map(strip).join("\n");
		expect(text).toContain("carol (pinned)");
	});

	test("잔여 감소로 감지된 계정도 ▶를 달되 근거(조회 시각·감소 폭)를 적고, 오래되면 '마지막 차감 감지'가 된다", () => {
		const lines = renderFrame(
			state([
				row({ provider: "openai-codex", label: "ann", drained: { at: NOW - 60_000, percent: 3 } }),
				row({ provider: "openai-codex", slot: "login-2", label: "dana", drained: { at: NOW - 25 * 60_000, percent: 1 } }),
			]),
			120,
		).map(strip);
		const active = lines.findIndex((l) => l.startsWith("  ▶ ann"));
		expect(active).toBeGreaterThan(-1);
		expect(lines[active + 1]).toMatch(/^  │ +in use · -3% since poll 1m ago$/);
		const stale = lines.findIndex((l) => l.startsWith("  ● dana"));
		expect(stale).toBeGreaterThan(-1);
		expect(lines[stale + 1]).toMatch(/^  │ +last drain seen 25m ago$/);
	});

	test("pool-state 기록(lastUsedAt)이 있으면 잔여 감소 감지보다 우선한다", () => {
		const text = renderFrame(state([row({ label: "carol", lastUsedAt: NOW - 30_000, drained: { at: NOW - 60_000, percent: 3 } })]), 120)
			.map(strip)
			.join("\n");
		expect(text).toContain("in use · just now");
		expect(text).not.toContain("-3%");
	});

	test("키 안내와 마지막 갱신 시각이 항상 보인다", () => {
		const lines = renderFrame(state([row({})]), 100).map(strip);
		const text = lines.join("\n");
		expect(text).toMatch(/\[r\]/);
		expect(text).toMatch(/\[q\]/);
		expect(text).toMatch(/\d\d:\d\d:\d\d/);
	});

	test("만료 사유는 80칸 프레임에서도 잘리지 않는다", () => {
		const expired = buildRoster({ "claude-sdk-oauth": { type: "oauth", access: "a", expires: NOW - 1, accounts: [{ name: "carol", access: "a", expires: NOW - 1 }] } }, NOW)[0];
		const detail = expired?.detail ?? "";
		expect(detail.length).toBeGreaterThan(0);
		// README 데모와 같은 조건: 같은 프레임에 "alice (pinned)"(14칸) 제목이 있어 제목 열이 넓어진다
		const line = renderFrame(state([row({ label: "alice", pinned: true }), expired as AccountRow]), 80)
			.map(strip)
			.find((l) => l.includes("carol")) ?? "";
		expect(line).toContain(detail);
	});

	test("계정이 하나도 없으면 안내 문구를 보여준다", () => {
		const text = renderFrame(state([]), 80).map(strip).join("\n");
		expect(text).toContain("No accounts logged in");
	});
});
