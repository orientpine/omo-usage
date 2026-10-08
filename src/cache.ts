import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AccountRow } from "./types.ts";
import { buildRoster } from "./auth.ts";
import { collectUsage, RATE_LIMIT_COOLDOWN_MS, type CollectOptions } from "./collect.ts";
import { accountKey } from "./credentials.ts";

/**
 * 머신 공유 사용량 캐시. omo 세션마다 뜨는 footer 위젯·TUI·--once·--json이 모두 이 파일 하나를 함께 읽고 쓴다.
 * 세션 13개가 계정마다 따로 조회하면 Anthropic의 토큰당 429 창(약 95초)에 늘 걸리므로(2026-10-08 소유자 지시),
 * 실제 조회는 계정 항목이 오래됐을 때 잠금을 쥔 프로세스 하나만 한다. 토큰은 절대 쓰지 않는다 (AccountRow에는 토큰이 없다).
 */
export const DEFAULT_REFRESH_MS = 10 * 60_000;
/** 잠금 주인이 이보다 오래 붙들고 있으면 죽은 것으로 보고 푼다. 조회는 계정 병렬이고 요청당 15초 제한이라 넉넉하다. */
export const LOCK_STALE_MS = 45_000;
const LOCK_POLL_MS = 250;
/** 남이 조회 중이면 이만큼까지 기다렸다가 그 결과를 읽는다. 그래도 안 끝나면 잠금 없이 직접 조회한다. */
const LOCK_WAIT_MS = 60_000;
const CACHE_VERSION = 1;

export function cachePath(env: NodeJS.ProcessEnv = process.env): string {
	const dir = env["OMO_USAGE_CACHE_DIR"] || join(env["XDG_CACHE_HOME"] || join(homedir(), ".cache"), "omo-usage");
	return join(dir, "usage.json");
}

/** OMO_USAGE_REFRESH_SECONDS로 바꿀 수 있다. 429 쿨다운보다 짧게는 못 잡는다. */
export function refreshIntervalMs(env: NodeJS.ProcessEnv = process.env): number {
	const seconds = Number(env["OMO_USAGE_REFRESH_SECONDS"]);
	if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_REFRESH_MS;
	return Math.max(RATE_LIMIT_COOLDOWN_MS, seconds * 1000);
}

export interface CacheEntry {
	/** 이 계정을 마지막으로 실제 조회한 시각 (성공·실패 무관) */
	readonly checkedAt: number;
	readonly row: AccountRow;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** 파일이 없거나 깨졌으면 빈 캐시. 모양이 맞지 않는 항목은 버린다. */
export async function readCache(path: string): Promise<Map<string, CacheEntry>> {
	const entries = new Map<string, CacheEntry>();
	let raw: unknown;
	try {
		raw = JSON.parse(await readFile(path, "utf8"));
	} catch {
		return entries;
	}
	const root = record(raw);
	const accounts = record(root?.["accounts"]);
	if (root?.["version"] !== CACHE_VERSION || !accounts) return entries;
	for (const [key, value] of Object.entries(accounts)) {
		const entry = record(value);
		const row = record(entry?.["row"]);
		const checkedAt = entry?.["checkedAt"];
		if (!row || typeof checkedAt !== "number" || !Number.isFinite(checkedAt)) continue;
		if (typeof row["provider"] !== "string" || typeof row["slot"] !== "string" || !Array.isArray(row["windows"])) continue;
		if (accountKey(row["provider"], row["slot"]) !== key) continue;
		entries.set(key, { checkedAt, row: row as unknown as AccountRow });
	}
	return entries;
}

/** 임시 파일(0600)에 쓰고 rename으로 바꿔치기해, 읽는 쪽이 반쯤 쓴 파일을 보지 않게 한다. */
async function writeCache(path: string, entries: ReadonlyMap<string, CacheEntry>): Promise<void> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
	const handle = await open(tmp, "wx", 0o600);
	try {
		await handle.writeFile(JSON.stringify({ version: CACHE_VERSION, accounts: Object.fromEntries(entries) }));
	} finally {
		await handle.close();
	}
	await rename(tmp, path);
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** 주인 프로세스가 죽었거나 LOCK_STALE_MS보다 오래된 잠금. 아직 내용을 못 쓴 막 생긴 잠금은 파일 시각으로 판단한다. */
async function lockIsStale(path: string, now: number): Promise<boolean> {
	let text: string;
	try {
		text = await readFile(path, "utf8");
	} catch {
		return false;
	}
	const lock = record((() => {
		try {
			return JSON.parse(text) as unknown;
		} catch {
			return null;
		}
	})());
	const pid = lock?.["pid"];
	const at = lock?.["at"];
	if (typeof pid !== "number" || typeof at !== "number") {
		const stat = await Bun.file(path).stat().catch(() => null);
		return stat !== null && Date.now() - stat.mtimeMs > LOCK_STALE_MS;
	}
	return now - at > LOCK_STALE_MS || !pidAlive(pid);
}

/** O_EXCL로 잠금 파일을 만든다. 성공하면 풀 때 쓸 토큰을 돌려준다 (남의 잠금을 지우지 않도록). */
async function acquireLock(path: string, now: number): Promise<string | null> {
	await mkdir(dirname(path), { recursive: true, mode: 0o700 });
	for (let attempt = 0; attempt < 2; attempt++) {
		try {
			const handle = await open(path, "wx", 0o600);
			const token = randomUUID();
			try {
				await handle.writeFile(JSON.stringify({ pid: process.pid, at: now, token }));
			} finally {
				await handle.close();
			}
			return token;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (attempt > 0 || !(await lockIsStale(path, now))) return null;
		await rm(path, { force: true });
	}
	return null;
}

async function releaseLock(path: string, token: string): Promise<void> {
	const text = await readFile(path, "utf8").catch(() => "");
	if (text.includes(token)) await rm(path, { force: true });
}

/**
 * 다시 조회할 때가 된 계정인가. 429의 retryAt 전이거나 마지막 조회가 쿨다운 안이면 강제 새로고침이어도 부르지 않는다.
 * 막대가 있는 계정은 간격(기본 10분)마다, 막대가 없는 계정(오류·첫 조회 실패)은 쿨다운마다 다시 묻는다.
 */
export function isDue(entry: CacheEntry | undefined, now: number, intervalMs: number, force: boolean): boolean {
	if (entry === undefined) return true;
	if (entry.row.retryAt !== undefined && entry.row.retryAt > now) return false;
	const age = now - entry.checkedAt;
	if (age < 0) return true;
	if (age < RATE_LIMIT_COOLDOWN_MS) return false;
	return force || age >= (entry.row.windows.length > 0 ? intervalMs : RATE_LIMIT_COOLDOWN_MS);
}

export interface SharedOptions extends CollectOptions {
	readonly cachePath?: string;
	readonly intervalMs?: number;
	/** TUI [r]: 간격은 무시하되 쿨다운과 retryAt은 지킨다. */
	readonly force?: boolean;
	readonly sleep?: (ms: number) => Promise<void>;
}

/** 캐시에 저장할 때는 세션마다 다시 붙이는 pool 정보(lastUsedAt)를 뺀다. */
function stored(row: AccountRow): AccountRow {
	const { lastUsedAt: _lastUsedAt, ...rest } = row;
	return rest;
}

/**
 * collectUsage의 공유 캐시판. 신선한 계정은 캐시 값을 쓰고, 오래된 계정만 잠금을 쥔 프로세스 하나가 조회해 캐시에 합친다.
 * 남이 조회 중이면 끝나기를 기다렸다가 그 결과를 읽는다. 캐시를 쓸 수 없는 환경이면 예전처럼 직접 조회한다.
 */
export async function collectShared(auth: unknown, options: SharedOptions = {}): Promise<AccountRow[]> {
	const now = options.now ?? Date.now();
	const path = options.cachePath ?? cachePath();
	const lockPath = `${path}.lock`;
	const intervalMs = options.intervalMs ?? refreshIntervalMs();
	const sleep = options.sleep ?? ((ms: number) => Bun.sleep(ms));
	const keys = buildRoster(auth, now)
		.filter((row) => row.status === "loading")
		.map((row) => accountKey(row.provider, row.slot));
	const dueIn = (cache: ReadonlyMap<string, CacheEntry>): Set<string> => new Set(keys.filter((key) => isDue(cache.get(key), now, intervalMs, options.force === true)));
	const serve = (cache: ReadonlyMap<string, CacheEntry>, due: ReadonlySet<string>): Promise<AccountRow[]> =>
		collectUsage(auth, { ...options, now, previous: [...cache.values()].map((entry) => entry.row), reuse: new Set(keys.filter((key) => !due.has(key))) });

	const deadline = Date.now() + LOCK_WAIT_MS;
	for (;;) {
		let cache: Map<string, CacheEntry>;
		let lock: string | null;
		try {
			cache = await readCache(path);
			if (dueIn(cache).size === 0) return serve(cache, new Set());
			lock = await acquireLock(lockPath, now);
		} catch {
			return collectUsage(auth, options);
		}
		if (lock === null && Date.now() < deadline) {
			await sleep(LOCK_POLL_MS);
			continue;
		}
		try {
			// 잠금을 기다리는 사이 다른 프로세스가 채웠을 수 있으니 다시 읽고 남은 것만 조회한다.
			cache = await readCache(path);
			const due = dueIn(cache);
			const rows = await serve(cache, due);
			if (due.size > 0) {
				const merged = await readCache(path);
				for (const row of rows) {
					const key = accountKey(row.provider, row.slot);
					if (due.has(key)) merged.set(key, { checkedAt: now, row: stored(row) });
				}
				await writeCache(path, merged).catch(() => {});
			}
			return rows;
		} finally {
			if (lock !== null) await releaseLock(lockPath, lock).catch(() => {});
		}
	}
}
