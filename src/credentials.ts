import { homedir } from "node:os";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, join } from "node:path";

/** senpi가 쓰는 자격증명 파일. 이 앱은 절대 여기에 쓰지 않는다 (읽기 전용). */
export const AUTH_PATH = `${homedir()}/.omo/agent/auth.json`;

export interface Secret {
	readonly access: string;
	readonly accountId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function usableAccess(value: unknown): value is string {
	return typeof value === "string" && value.length > 0 && value !== "claude-sdk-oauth-managed" && value !== "anthropic-subscription-managed";
}

/**
 * Claude CLI 저장소 계약 (senpi readClaudeCliAccessToken, 2026-11-06 실측).
 * 링크와 읽는 도중 바뀐 파일/디렉터리는 거부한다. 만료는 로스터가 판단하며 갱신은 절대 하지 않는다.
 */
async function cliAccount(account: unknown, agentDir: string): Promise<unknown> {
	const slot = record(account);
	if (slot?.["store"] !== "claude-cli") return account;
	// CLI 슬롯에 남은 구형 access/expires나 managed 표식을 대체 토큰으로 쓰지 않는다.
	const { access: _access, expires: _expires, ...metadata } = slot;
	const dirId = slot["dirId"];
	if (typeof dirId !== "string" || !/^[0-9a-f]{32}$/.test(dirId)) return metadata;
	const dir = join(agentDir, "anthropic-subscription-claude", dirId);
	const file = join(dir, ".credentials.json");
	try {
		const [dirStats, fileStats] = await Promise.all([lstat(dir), lstat(file)]);
		if (!dirStats.isDirectory() || !fileStats.isFile()) return metadata;
		const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
		let parsed: unknown;
		try {
			const opened = await handle.stat();
			if (!opened.isFile() || opened.ino !== fileStats.ino || opened.dev !== fileStats.dev) return metadata;
			parsed = JSON.parse(await handle.readFile("utf8"));
		} finally {
			await handle.close();
		}
		const dirAfter = await lstat(dir);
		if (!dirAfter.isDirectory() || dirAfter.ino !== dirStats.ino || dirAfter.dev !== dirStats.dev) return metadata;
		const oauth = record(record(parsed)?.["claudeAiOauth"]);
		const access = oauth?.["accessToken"];
		if (!usableAccess(access)) return metadata;
		const expires = oauth?.["expiresAt"];
		return { ...metadata, access, expires: typeof expires === "number" && Number.isFinite(expires) ? expires : null };
	} catch (error) {
		// 파일/JSON 오류 본문에는 비밀이 들어갈 수 있어 화면이나 로그에 전달하지 않는다.
		if (error instanceof Error) return metadata;
		throw error;
	}
}

/** Codex 요청에 필요한 ChatGPT-Account-Id는 액세스 토큰(JWT) 안에 들어 있다. */
export function accountIdFromJwt(token: string): string | null {
	try {
		const segment = token.split(".")[1];
		if (!segment) return null;
		const claims = record(JSON.parse(Buffer.from(segment, "base64url").toString("utf8")));
		const auth = record(claims?.["https://api.openai.com/auth"]);
		const id = auth?.["chatgpt_account_id"] ?? claims?.["chatgpt_account_id"];
		return typeof id === "string" && id.length > 0 ? id : null;
	} catch {
		return null;
	}
}

export function accountKey(provider: string, slot: string): string {
	return `${provider}/${slot}`;
}

/**
 * provider/slot -> 토큰 맵. 이 맵은 fetch 호출에서만 쓰이고
 * 화면 상태(AccountRow)에는 절대 들어가지 않는다.
 */
export function secretsFrom(auth: unknown): Map<string, Secret> {
	const root = record(auth);
	const secrets = new Map<string, Secret>();
	if (!root) return secrets;

	for (const [provider, value] of Object.entries(root)) {
		const entry = record(value);
		if (!entry) continue;
		const accounts = Array.isArray(entry["accounts"]) && entry["accounts"].length > 0 ? entry["accounts"] : [{ ...entry, name: "default" }];
		for (const raw of accounts) {
			const account = record(raw);
			const access = account?.["access"];
			if (!usableAccess(access)) continue;
			const slot = typeof account?.["name"] === "string" && account["name"].length > 0 ? (account["name"] as string) : "default";
			const explicitId = typeof entry["accountId"] === "string" ? (entry["accountId"] as string) : null;
			secrets.set(accountKey(provider, slot), { access, accountId: accountIdFromJwt(access) ?? explicitId });
		}
	}
	return secrets;
}

export async function readAuthFile(path: string = AUTH_PATH): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) throw new Error(`credentials file not found: ${path}`);
	const auth = record(await file.json());
	if (!auth) return auth;
	// CLI/TUI/footer가 모두 이 경로로 읽는다. 원본 파일은 그대로 두고 메모리에서만 해석한다.
	return Object.fromEntries(await Promise.all(Object.entries(auth).map(async ([provider, value]) => {
		if (provider !== "anthropic-subscription" && provider !== "claude-sdk-oauth") return [provider, value];
		const entry = record(value);
		if (!entry) return [provider, value];
		if (!Array.isArray(entry["accounts"])) return [provider, await cliAccount(entry, dirname(path))];
		return [provider, { ...entry, accounts: await Promise.all(entry["accounts"].map((account: unknown) => cliAccount(account, dirname(path)))) }];
	})));
}
