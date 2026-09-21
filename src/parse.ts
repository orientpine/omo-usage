import type { UsageWindow, WindowKind } from "./types.ts";

const FIVE_HOURS_SECONDS = 18_000;
const WEEK_SECONDS = 604_800;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function finite(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** 사용률(0..100)을 남은 비율로 뒤집는다. 숫자가 아니면 null — 절대 지어내지 않는다. */
function remainingFrom(used: unknown): number | null {
	const value = finite(used);
	return value === null ? null : Math.round(100 - Math.min(100, Math.max(0, value)));
}

function isoToEpoch(value: unknown): number | null {
	if (typeof value !== "string") return null;
	const parsed = Date.parse(value);
	return Number.isFinite(parsed) ? parsed : null;
}

function durationLabel(seconds: number): string {
	if (seconds >= 86_400) return `${Math.round(seconds / 86_400)}d`;
	if (seconds >= 3_600) return `${Math.round(seconds / 3_600)}h`;
	return `${Math.max(1, Math.round(seconds / 60))}m`;
}

function windowFrom(label: string, kind: WindowKind, used: unknown, resetsAt: number | null): UsageWindow | null {
	const remainingPercent = remainingFrom(used);
	return remainingPercent === null ? null : { label, kind, remainingPercent, resetsAt };
}

/**
 * GET https://api.anthropic.com/api/oauth/usage 응답 파싱.
 * 5h/7d는 최상위 키에서, 모델별 주간 한도는 limits[]의 weekly_scoped에서 가져온다.
 */
export function parseClaudeUsage(payload: unknown): UsageWindow[] {
	const root = record(payload);
	if (!root) return [];

	const windows: UsageWindow[] = [];

	const fiveHour = record(root["five_hour"]);
	if (fiveHour) {
		const w = windowFrom("5h", "session", fiveHour["utilization"], isoToEpoch(fiveHour["resets_at"]));
		if (w) windows.push(w);
	}

	const sevenDay = record(root["seven_day"]);
	if (sevenDay) {
		const w = windowFrom("7d", "weekly", sevenDay["utilization"], isoToEpoch(sevenDay["resets_at"]));
		if (w) windows.push(w);
	}

	const limits = root["limits"];
	if (Array.isArray(limits)) {
		for (const raw of limits) {
			const limit = record(raw);
			if (!limit || limit["kind"] !== "weekly_scoped") continue;
			const model = record(record(limit["scope"])?.["model"]);
			const name = model?.["display_name"];
			if (typeof name !== "string" || name.length === 0) continue;
			const w = windowFrom(name, "scoped", limit["percent"], isoToEpoch(limit["resets_at"]));
			if (w) windows.push(w);
		}
	}

	return windows;
}

export interface CodexUsage {
	readonly windows: UsageWindow[];
	readonly plan: string | null;
}

/**
 * GET https://chatgpt.com/backend-api/wham/usage 응답 파싱.
 * primary/secondary는 계정마다 의미가 다르다(pro 계정은 primary가 주간, team 계정은 primary가 5시간).
 * 그래서 위치가 아니라 limit_window_seconds로 창을 구분한다.
 */
export function parseCodexUsage(payload: unknown, now: number = Date.now()): CodexUsage {
	const root = record(payload);
	if (!root) return { windows: [], plan: null };

	const plan = typeof root["plan_type"] === "string" ? root["plan_type"] : null;
	const rateLimit = record(root["rate_limit"]);
	if (!rateLimit) return { windows: [], plan };

	const windows: { window: UsageWindow; seconds: number }[] = [];
	for (const key of ["primary_window", "secondary_window"]) {
		const win = record(rateLimit[key]);
		if (!win) continue;
		const seconds = finite(win["limit_window_seconds"]);
		if (seconds === null) continue;

		const resetAt = finite(win["reset_at"]);
		const resetAfter = finite(win["reset_after_seconds"]);
		const resetsAt = resetAt !== null ? resetAt * 1000 : resetAfter !== null ? now + resetAfter * 1000 : null;

		const kind: WindowKind = seconds === FIVE_HOURS_SECONDS ? "session" : seconds === WEEK_SECONDS ? "weekly" : "other";
		const label = seconds === FIVE_HOURS_SECONDS ? "5h" : seconds === WEEK_SECONDS ? "7d" : durationLabel(seconds);
		const w = windowFrom(label, kind, win["used_percent"], resetsAt);
		if (w) windows.push({ window: w, seconds });
	}

	windows.sort((a, b) => a.seconds - b.seconds);
	return { windows: windows.map((w) => w.window), plan };
}

export interface XaiUsage {
	readonly windows: UsageWindow[];
	/** 같은 크레딧 풀에서 제품별로 쓴 몫 (예: "사용 내역 GrokBuild 12% · GrokImagine 1%"). 없으면 null */
	readonly note: string | null;
}

/** proto3 JSON은 0인 스칼라의 키를 아예 빼고 보낸다. 부모 객체가 있는데 키만 없으면 0이다. */
function protoNumber(parent: Record<string, unknown>, key: string): number | null {
	return key in parent ? finite(parent[key]) : 0;
}

/**
 * GET https://cli-chat-proxy.grok.com/v1/billing?format=credits 응답 파싱 (Grok CLI `/usage`가 쓰는 엔드포인트).
 * 주간 풀 사용률 creditUsagePercent 하나가 막대가 되고, productUsage[]는 그 풀을 제품별로 나눈 내역이라 막대가 아니라 문구로 붙인다.
 * proto3 생략 규칙은 config.currentPeriod가 있을 때만 적용한다 — 그게 없으면 크레딧 응답이 아니므로 0을 지어내지 않는다.
 */
export function parseXaiUsage(payload: unknown): XaiUsage {
	const config = record(record(payload)?.["config"]);
	const period = config ? record(config["currentPeriod"]) : null;
	if (!config || !period) return { windows: [], note: null };

	const kind: WindowKind = period["type"] === "USAGE_PERIOD_TYPE_WEEKLY" ? "weekly" : "other";
	const start = isoToEpoch(period["start"]);
	const resetsAt = isoToEpoch(period["end"]) ?? isoToEpoch(config["billingPeriodEnd"]);
	const label = kind === "weekly" ? "7d" : start !== null && resetsAt !== null && resetsAt > start ? durationLabel((resetsAt - start) / 1000) : "기간";
	const window = windowFrom(label, kind, protoNumber(config, "creditUsagePercent"), resetsAt);

	const parts: string[] = [];
	const products = config["productUsage"];
	if (Array.isArray(products)) {
		for (const raw of products) {
			const item = record(raw);
			const name = item?.["product"];
			if (!item || typeof name !== "string" || name.length === 0) continue;
			const used = protoNumber(item, "usagePercent");
			if (used === null) continue;
			parts.push(`${name} ${Math.round(used * 10) / 10}%`);
		}
	}

	return { windows: window ? [window] : [], note: parts.length > 0 ? `사용 내역 ${parts.join(" · ")}` : null };
}

/** proto3 JSON은 int64를 문자열로 본다("100"). 문자없이 오는 숫자와 문자열 모두 읽되, 해석 불가면 null이다. */
function numberOrString(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value);
		return Number.isFinite(parsed) ? parsed : null;
	}
	return null;
}

/** duration + timeUnit(TIME_UNIT_MINUTE 등)을 초로 환산한다. 모르는 단위는 null. */
function windowSeconds(duration: unknown, timeUnit: unknown): number | null {
	const value = numberOrString(duration);
	if (value === null || value <= 0) return null;
	const factor = timeUnit === "TIME_UNIT_MINUTE" ? 60 : timeUnit === "TIME_UNIT_HOUR" ? 3_600 : timeUnit === "TIME_UNIT_DAY" ? 86_400 : timeUnit === "TIME_UNIT_SECOND" ? 1 : null;
	return factor === null ? null : value * factor;
}

/** limit/remaining(없으면 limit-used) 카운트에서 남은 비율을 만든다. limit이 0이면 나눌 수 없으니 null. */
function remainingPercentFromCounts(detail: Record<string, unknown>): number | null {
	const limit = numberOrString(detail["limit"]);
	if (limit === null || limit <= 0) return null;
	const remaining = numberOrString(detail["remaining"]);
	const used = numberOrString(detail["used"]);
	const left = remaining ?? (used !== null ? limit - used : null);
	return left === null ? null : Math.round((Math.min(limit, Math.max(0, left)) / limit) * 100);
}

/**
 * GET https://api.kimi.com/coding/v1/usages 응답 파싱 (Kimi Code 구독, 2026-09-21 실측).
 * limits[]는 롤링 창(300분=5h), usage는 주간 쿼터다. usages.limit_*.used_ratio는 정수로 몸개진 값
 * (7% 사용인데 0으로 옴)이라 쓰지 않고 실제 카운트(remaining/limit)만 읽는다.
 * limits[]에 주간 길이 창이 있으면 usage와 라벨이 겹치므로 먼저 온 창 하나만 그린다.
 */
export function parseKimiUsage(payload: unknown): UsageWindow[] {
	const root = record(payload);
	if (!root) return [];

	const windows: UsageWindow[] = [];
	const seen = new Set<string>();

	const limits = root["limits"];
	if (Array.isArray(limits)) {
		for (const raw of limits) {
			const item = record(raw);
			const detail = record(item?.["detail"]);
			const win = record(item?.["window"]);
			if (!detail || !win) continue;
			const seconds = windowSeconds(win["duration"], win["timeUnit"]);
			if (seconds === null) continue;
			const remainingPercent = remainingPercentFromCounts(detail);
			if (remainingPercent === null) continue;
			const label = seconds === FIVE_HOURS_SECONDS ? "5h" : seconds === WEEK_SECONDS ? "7d" : durationLabel(seconds);
			if (seen.has(label)) continue;
			seen.add(label);
			const kind: WindowKind = seconds === FIVE_HOURS_SECONDS ? "session" : seconds === WEEK_SECONDS ? "weekly" : "other";
			windows.push({ label, kind, remainingPercent, resetsAt: isoToEpoch(detail["resetTime"]) });
		}
	}

	const usage = record(root["usage"]);
	if (usage && !seen.has("7d")) {
		const remainingPercent = remainingPercentFromCounts(usage);
		if (remainingPercent !== null) windows.push({ label: "7d", kind: "weekly", remainingPercent, resetsAt: isoToEpoch(usage["resetTime"]) });
	}

	return windows;
}
