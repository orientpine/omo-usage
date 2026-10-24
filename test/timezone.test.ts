import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderFrame, resetStamp, setDisplayTimeZone, updatedStamp } from "../src/render.ts";
import { configPath, resolveTimeZone } from "../src/timezone.ts";
import type { AccountRow } from "../src/types.ts";

const none = () => undefined;
const ESC = /\u001B\[[0-9;]*m/g;

describe("resolveTimeZone", () => {
	test("설정이 없으면 시스템 시간대(undefined)", () => {
		expect(resolveTimeZone({}, none)).toEqual({ zone: undefined, notice: null });
	});

	test("OMO_USAGE_TZ가 설정 파일보다 앞선다", () => {
		expect(resolveTimeZone({ OMO_USAGE_TZ: "America/New_York" }, () => "Asia/Seoul").zone).toBe("America/New_York");
		expect(resolveTimeZone({}, () => "Asia/Seoul").zone).toBe("Asia/Seoul");
	});

	test("KST 약칭은 Asia/Seoul로 받는다", () => {
		expect(resolveTimeZone({ OMO_USAGE_TZ: "kst" }, none).zone).toBe("Asia/Seoul");
	});

	test("모르는 이름이나 깨진 설정 파일은 시스템 시간대로 두고 notice를 단다", () => {
		const bad = resolveTimeZone({ OMO_USAGE_TZ: "Mars/Olympus" }, none);
		expect(bad.zone).toBeUndefined();
		expect(bad.notice).toContain('"Mars/Olympus" in OMO_USAGE_TZ');
		const broken = resolveTimeZone({}, () => {
			throw new SyntaxError("Unexpected token");
		});
		expect(broken.zone).toBeUndefined();
		expect(broken.notice).toContain("Unexpected token");
	});

	test("$XDG_CONFIG_HOME/omo-usage/config.json의 timeZone을 읽는다", () => {
		const home = mkdtempSync(join(tmpdir(), "omo-usage-tz-"));
		try {
			const env = { XDG_CONFIG_HOME: home };
			expect(resolveTimeZone(env).zone).toBeUndefined();
			mkdirSync(join(home, "omo-usage"));
			writeFileSync(configPath(env), JSON.stringify({ timeZone: "Asia/Seoul" }));
			expect(resolveTimeZone(env)).toEqual({ zone: "Asia/Seoul", notice: null });
		} finally {
			rmSync(home, { recursive: true, force: true });
		}
	});
});

describe("표시 시간대", () => {
	afterEach(() => setDisplayTimeZone({ zone: undefined, notice: null }));

	// 2026-10-23 05:12:24 UTC = 14:12:24 KST
	const NOW = Date.UTC(2026, 9, 23, 5, 12, 24);
	const row: AccountRow = {
		provider: "anthropic-subscription",
		slot: "default",
		label: "alice",
		status: "ok",
		detail: null,
		plan: null,
		expiresAt: null,
		fetchedAt: NOW,
		windows: [
			{ label: "5h", kind: "session", remainingPercent: 50, resetsAt: Date.UTC(2026, 9, 23, 9, 0) },
			{ label: "7d", kind: "weekly", remainingPercent: 80, resetsAt: Date.UTC(2026, 9, 23, 15, 59) },
		],
	};

	test("날짜가 바뀌는 경계: UTC 15:59는 KST 다음날 00:59", () => {
		setDisplayTimeZone({ zone: "Asia/Seoul", notice: null });
		expect(resetStamp(Date.UTC(2026, 9, 23, 15, 59), NOW)).toBe("10/24 00:59");
		// 지금이 KST로 이미 24일이면 같은 날이라 시각만
		expect(resetStamp(Date.UTC(2026, 9, 23, 15, 59), Date.UTC(2026, 9, 23, 15, 30))).toBe("00:59");
		expect(updatedStamp(NOW, NOW)).toBe("updated 14:12");
	});

	test("TUI 헤더·리셋·retry가 모두 KST이고 헤더에 KST를 단다", () => {
		setDisplayTimeZone({ zone: "Asia/Seoul", notice: null });
		const retry: AccountRow = { ...row, slot: "bob", label: "bob", status: "error", detail: "rate limited (HTTP 429)", windows: [], fetchedAt: undefined, retryAt: Date.UTC(2026, 9, 23, 5, 20) };
		const text = renderFrame({ rows: [row, retry], updatedAt: NOW, refreshing: false, error: null, now: NOW }, 140)
			.map((l) => l.replace(ESC, ""))
			.join("\n");
		expect(text).toContain("updated 14:12:24 KST");
		expect(text).toContain("resets 18:00");
		expect(text).toContain("resets 10/24 00:59");
		expect(text).toContain("retry 14:20");
	});

	test("시스템 시간대(설정 없음)면 헤더에 시간대를 붙이지 않고, 잘못된 설정은 notice 줄을 보인다", () => {
		setDisplayTimeZone({ zone: undefined, notice: 'unknown time zone "Mars/Olympus" in OMO_USAGE_TZ · showing system time' });
		const lines = renderFrame({ rows: [row], updatedAt: NOW, refreshing: false, error: null, now: NOW }, 140).map((l) => l.replace(ESC, ""));
		expect(lines.join("\n")).not.toContain("KST");
		expect(lines.some((l) => l.includes('unknown time zone "Mars/Olympus"'))).toBe(true);
	});
});
