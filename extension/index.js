// senpi(omo)가 불러오는 진입점. 호스트만 줄 수 있는 내장 FooterComponent와 TUI 폭 계산(truncateToWidth)을 넘기고, 나머지는 src/footer.ts에 있다.
import { FooterComponent } from "@code-yeongyu/senpi";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { createFooterExtension } from "../src/footer.ts";

export default createFooterExtension({ FooterComponent, fit: (text, width) => truncateToWidth(text, width, "…") });
