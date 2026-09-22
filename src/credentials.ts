import { homedir } from "node:os";

/** senpi가 쓰는 자격증명 파일. 이 앱은 절대 여기에 쓰지 않는다 (읽기 전용). */
export const AUTH_PATH = `${homedir()}/.omo/agent/auth.json`;

export interface Secret {
	readonly access: string;
	readonly accountId: string | null;
}

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
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
			if (typeof access !== "string" || access.length === 0) continue;
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
	return file.json();
}
