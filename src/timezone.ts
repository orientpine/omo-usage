import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 화면 시각을 맞출 시간대. zone이 undefined면 시스템 시간대를 쓴다. notice는 설정이 잘못됐을 때 화면에 띄울 한 줄. */
export interface TimeZoneSetting {
	readonly zone: string | undefined;
	readonly notice: string | null;
}

/** IANA 이름이 아닌 흔한 약칭. Intl은 "KST"를 받지 않는다. */
const ALIASES: Readonly<Record<string, string>> = { KST: "Asia/Seoul" };

export function configPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env["XDG_CONFIG_HOME"] || join(homedir(), ".config"), "omo-usage", "config.json");
}

/** 파일이 없으면 undefined, JSON이 깨졌으면 예외. */
function readConfigZone(path: string): string | undefined {
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
		throw error;
	}
	const value = (JSON.parse(text) as Record<string, unknown> | null)?.["timeZone"];
	return typeof value === "string" ? value : undefined;
}

/** 우선순위: OMO_USAGE_TZ > 설정 파일의 "timeZone" > 시스템 시간대. 잘못된 이름이면 시스템 시간대로 두고 notice를 단다. */
export function resolveTimeZone(env: NodeJS.ProcessEnv = process.env, readZone: (path: string) => string | undefined = readConfigZone): TimeZoneSetting {
	const fromEnv = env["OMO_USAGE_TZ"]?.trim();
	const source = fromEnv ? "OMO_USAGE_TZ" : configPath(env);
	let raw = fromEnv;
	if (!raw) {
		try {
			raw = readZone(source)?.trim();
		} catch (error) {
			return { zone: undefined, notice: `cannot read ${source} (${(error as Error).message}) · showing system time` };
		}
	}
	if (!raw) return { zone: undefined, notice: null };
	const name = ALIASES[raw.toUpperCase()] ?? raw;
	try {
		return { zone: new Intl.DateTimeFormat("en-US", { timeZone: name }).resolvedOptions().timeZone, notice: null };
	} catch {
		return { zone: undefined, notice: `unknown time zone "${raw}" in ${source} · showing system time` };
	}
}
