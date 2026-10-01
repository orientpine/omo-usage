// senpi(omo)가 불러오는 진입점. 호스트 내부 모듈은 쓰지 않고 공식 확장 API(ctx.ui.setWidget)만 쓴다 — 구현은 src/footer.ts.
import { createFooterExtension } from "../src/footer.ts";

export default createFooterExtension();
