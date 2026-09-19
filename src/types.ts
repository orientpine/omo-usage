export type AccountStatus = "ok" | "expired" | "error" | "unsupported" | "loading";

export type WindowKind = "session" | "weekly" | "scoped" | "other";

export interface UsageWindow {
	/** 화면에 찍히는 짧은 라벨: "5h", "7d", "Fable" 등 */
	readonly label: string;
	readonly kind: WindowKind;
	/** 남은 비율 0..100 (100 = 아직 하나도 안 씀) */
	readonly remainingPercent: number;
	/** epoch ms. 알 수 없으면 null */
	readonly resetsAt: number | null;
}

export interface AccountRow {
	readonly provider: string;
	/** auth.json 안의 슬롯 이름 (default, login-2, 사용자가 지은 이름 ...) */
	readonly slot: string;
	/** 사람이 읽는 이름 (displayName 우선) */
	readonly label: string;
	readonly status: AccountStatus;
	/** 상태 보조 설명 (에러 사유, n/a 이유 등) */
	readonly detail: string | null;
	/** codex plan_type 등 */
	readonly plan: string | null;
	/** 액세스 토큰 만료 시각 epoch ms */
	readonly expiresAt: number | null;
	readonly windows: readonly UsageWindow[];
	/** 429를 받은 계정은 이 시각(epoch ms)까지 다시 조회하지 않는다 */
	readonly retryAt?: number;
	/** 막대 아래 가이드 줄에 dim으로 붙는 보조 정보 (xai 제품별 사용 내역 등) */
	readonly note?: string;
}
