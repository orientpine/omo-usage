import { homedir } from "node:os";
import type { AccountRow } from "./types.ts";
import { accountKey } from "./credentials.ts";

/** senpi의 credential pool 상태. auth.json과 마찬가지로 이 앱은 절대 여기에 쓰지 않는다. */
export const POOL_STATE_PATH = `${homedir()}/.omo/agent/credential-pool-state.json`;

function record(value: unknown): Record<string, unknown> | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * `providers.<provider>.lanes.<lane>.slots.<slot>.lastSuccessAt` 를 provider/slot 키로 편다.
 * senpi는 요청이 성공할 때마다 그 슬롯의 값을 갱신하므로(credential-pool/rotation-stream.js) 이 시각이
 * "그 계정이 실제로 차감된 마지막 순간"이다. 계정 선택은 세션별 해시(affinity.js)라 전역 "현재 계정"은 없고,
 * 세션이 여럿이면 여러 슬롯이 동시에 최근일 수 있다.
 */
export function lastUsedBySlot(poolState: unknown): Map<string, number> {
	const used = new Map<string, number>();
	const providers = record(record(poolState)?.["providers"]);
	if (!providers) return used;

	for (const [provider, providerValue] of Object.entries(providers)) {
		const lanes = record(record(providerValue)?.["lanes"]);
		if (!lanes) continue;
		for (const laneValue of Object.values(lanes)) {
			const slots = record(record(laneValue)?.["slots"]);
			if (!slots) continue;
			for (const [slot, slotValue] of Object.entries(slots)) {
				const at = record(slotValue)?.["lastSuccessAt"];
				if (typeof at !== "number" || !Number.isFinite(at) || at <= 0) continue;
				const key = accountKey(provider, slot);
				const previous = used.get(key);
				if (previous === undefined || at > previous) used.set(key, at);
			}
		}
	}
	return used;
}

export function stampLastUsed(rows: readonly AccountRow[], poolState: unknown): AccountRow[] {
	const lastUsed = lastUsedBySlot(poolState);
	return rows.map((row) => {
		const at = lastUsed.get(accountKey(row.provider, row.slot));
		return at === undefined ? row : { ...row, lastUsedAt: at };
	});
}

export async function readPoolState(path: string = POOL_STATE_PATH): Promise<unknown> {
	const file = Bun.file(path);
	if (!(await file.exists())) return null;
	try {
		return await file.json();
	} catch {
		return null;
	}
}
