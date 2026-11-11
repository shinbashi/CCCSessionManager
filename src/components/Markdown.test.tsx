import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { toMarkdownSource } from "../format";
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

  it("全文表示: 2000 文字を超える 1 行の JSON も、字下げ・色分けして表示する", () => {
    const items = Array.from({ length: 80 }, (_, i) => ({ id: i, url: `https://example.com/${i}`, name: `item-${i}` }));
    const full = JSON.stringify({ items });
    expect(full.length).toBeGreaterThan(2000);

    const { source, format } = toMarkdownSource({ kind: "tool_result", text: full });
    const out = html(source);

    expect(format).toBe("json");
    expect(out).toContain("hljs-attr");
    expect(source.split("\n").length).toBeGreaterThan(80 * 3);
    expect(out).toContain('<a href="https://example.com/79"');
  });

  it("全文表示: 長い Markdown も見出し・リストとして表示する", () => {
    const md = `# 結果\n\n${Array.from({ length: 300 }, (_, i) => `- 項目 ${i}`).join("\n")}`;
    const out = html(toMarkdownSource({ kind: "assistant", text: md }).source);
    expect(out).toContain("<h1>結果</h1>");
    expect(out.match(/<li>/g)).toHaveLength(300);
  });

  it("生の HTML は解釈せず文字として表示する", () => {
    const out = html('<img src=x onerror="alert(1)">');
    expect(out).not.toContain("<img");
  });
});
