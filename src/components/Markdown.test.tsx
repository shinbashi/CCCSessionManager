import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Markdown } from "./Markdown";

const html = (source: string) => renderToStaticMarkup(<Markdown source={source} />);

describe("Markdown", () => {
  it("本文中の URL をリンクにする", () => {
    expect(html("詳細は https://example.com/a を参照")).toContain('<a href="https://example.com/a"');
  });

  it("コードブロック (JSON) の文字列の中の URL もリンクにする", () => {
    const out = html('```json\n{"url": "https://example.com/x"}\n```');
    expect(out).toContain('<a href="https://example.com/x"');
    expect(out).toContain("hljs-string");
  });

  it("Markdown のリンクはそのまま (二重にリンクしない)", () => {
    const out = html("[docs](https://example.com/docs)");
    expect(out.match(/<a /g)).toHaveLength(1);
  });

  it("生の HTML は解釈せず文字として表示する", () => {
    const out = html('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
  });
});
