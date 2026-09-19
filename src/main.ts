import { collectUsage } from "./collect.ts";
import { readAuthFile, AUTH_PATH } from "./credentials.ts";

const HELP = `omo-usage — omo-ai에 로그인된 모든 계정의 잔여 사용량

사용법:
  omo-usage            TUI 실행 (r 새로고침 · q 종료)
  omo-usage --once     한 번만 조회해서 출력하고 종료
  omo-usage --json     JSON으로 출력하고 종료 (토큰은 절대 포함하지 않음)
  omo-usage --help     이 도움말

자격증명: ${AUTH_PATH} (읽기 전용)`;

function plain(rows: Awaited<ReturnType<typeof collectUsage>>): string {
	return rows
		.map((row) => {
			const windows = row.windows.map((w) => `${w.label} ${w.remainingPercent}% 남음`).join(" · ");
			const status = row.status === "ok" ? (row.note ? `${windows} · ${row.note}` : windows) : `${row.status.toUpperCase()}${row.detail ? ` (${row.detail})` : ""}`;
			return `${row.provider.padEnd(17)} ${row.label.padEnd(12)} ${status}`;
		})
		.join("\n");
}

const args = new Set(Bun.argv.slice(2));

if (args.has("--help") || args.has("-h")) {
	console.log(HELP);
	process.exit(0);
}

if (args.has("--json") || args.has("--once")) {
	const auth = await readAuthFile();
	const rows = await collectUsage(auth);
	console.log(args.has("--json") ? JSON.stringify(rows, null, 2) : plain(rows));
	process.exit(0);
}

const { runTui } = await import("./tui.ts");
await runTui();
