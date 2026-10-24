import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { AUTH_PATH } from "./credentials.ts";
import type { UsageWindow } from "./types.ts";

/**
 * senpi 자체 사용량 조회기(usage-poller, senpi#3684)가 머신 전체에서 계정당 5분마다 받아 두는 파일.
 * 같은 토큰으로 omo-usage가 또 부르면 senpi 성공 직후의 429 창(약 95초)에 걸려 옛 막대만 남으므로(2026-10-24 실측: 9시간),
 * senpi가 이미 받은 값을 읽어 쓴다. 이 파일에는 계정 이름과 사용률만 있고 토큰은 없다 (senpi usage-cache.js sanitize). 읽기만 한다.
 */
export function senpiUsagePath(env: NodeJS.ProcessEnv = process.env): string {
	return env["OMO_USAGE_SENPI_USAGE_PATH"] || join(dirname(AUTH_PATH), "subscription-usage.json");
}

export interface SenpiReading {
	/** senpi가 이 값을 성공해 받은 시각 (epoch ms) */
	readonly fetchedAt: number;
	readonly windows: readonly UsageWindow[];
}

/** Anthropic만 읽는다: 429 창이 토큰당이라 겹치는 건 이 엔드포인트뿐이고, Codex·xAI는 omo-usage가 직접 받아도 잘 받는다. */
const CLAUDE_PROVIDERS = new Set(["anthropic-subscription", "claude-sdk-oauth"]);

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** `claude:7d_fable` -> `Fable`. 화면 라벨은 Anthropic display_name이라, 이전 막대에 같은 모델이 있으면 cache.ts가 그 라벨로 맞춘다. */
function scopedLabel(slug: string): string {
	return slug
		.split("_")
		.filter((part) => part.length > 0)
		.map((part) => part.charAt(0).toUpperCase() + part.slice(1))
		.join(" ");
}

export function scopedSlug(label: string): string {
	return label.toLowerCase().replace(/[^a-z0-9]+/g, "_");
}

function windowFrom(raw: unknown): UsageWindow | null {
	const window = record(raw);
	const id = window?.["id"];
	const used = window?.["usedPercent"];
	if (typeof id !== "string" || typeof used !== "number" || !Number.isFinite(used)) return null;
	const reset = typeof window?.["resetsAt"] === "string" ? Date.parse(window["resetsAt"] as string) : Number.NaN;
	const shape = { remainingPercent: Math.round(100 - Math.min(100, Math.max(0, used))), resetsAt: Number.isFinite(reset) ? reset : null };
	if (id === "claude:5h") return { label: "5h", kind: "session", ...shape };
	if (id === "claude:7d") return { label: "7d", kind: "weekly", ...shape };
	if (id.startsWith("claude:7d_")) return { label: scopedLabel(id.slice("claude:7d_".length)), kind: "scoped", ...shape };
	return null;
}

/**
 * provider/slot -> senpi가 마지막으로 성공해 받은 Claude 사용량. 오류가 붙은 읽기는 senpi가 실패 뒤 옛 창을 옮겨 둔 것이고
 * 그 updatedAt은 실패 시각이라, 성공 시각으로 쓸 수 없어 버린다. 파일이 없거나 깨졌으면 빈 맵이다.
 */
export async function readSenpiUsage(path: string = senpiUsagePath()): Promise<Map<string, SenpiReading>> {
	const readings = new Map<string, SenpiReading>();
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return readings;
	}
	for (const [key, value] of Object.entries(record(record(raw)?.["accounts"]) ?? {})) {
		if (!CLAUDE_PROVIDERS.has(key.slice(0, key.indexOf("/")))) continue;
		const reading = record(value);
		const updatedAt = reading?.["updatedAt"];
		if (!reading || reading["error"] !== undefined || typeof updatedAt !== "number" || !Number.isFinite(updatedAt)) continue;
		const windows = (Array.isArray(reading["windows"]) ? reading["windows"] : []).flatMap((w) => windowFrom(w) ?? []);
		if (windows.length > 0) readings.set(key, { fetchedAt: updatedAt, windows });
	}
	return readings;
}
