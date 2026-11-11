import { describe, expect, it } from "vitest";
import { detectFormat, fence, splitUrls, toMarkdownSource } from "./format";

describe("detectFormat", () => {
  it("{ や [ で始まるものは JSON (途中で切れていても)", () => {
    expect(detectFormat('{\n  "id": "abc",\n  "badges": {')).toBe("json");
    expect(detectFormat('  [{"a": 1}]')).toBe("json");
  });

  it("key: value の行が多いものは YAML", () => {
    expect(detectFormat("name: app\nversion: 1.0\nitems:\n  - a\n  - b")).toBe("yaml");
  });

  it("--- で始まる front matter は YAML", () => {
    expect(detectFormat("---\ntitle: hello\n---")).toBe("yaml");
  });

  it("見出し・コードブロック・箇条書きがあるものは Markdown", () => {
    expect(detectFormat("# 見出し\n\n本文")).toBe("markdown");
    expect(detectFormat("結果:\n```ts\nconst a = 1\n```")).toBe("markdown");
    expect(detectFormat("- 1 つ目\n- 2 つ目")).toBe("markdown");
  });

  it("どれでもないものは plain", () => {
    expect(detectFormat("File created successfully")).toBe("plain");
    expect(detectFormat("Error: command not found")).toBe("plain");
  });

  it("1 行だけの key: value は YAML とみなさない (エラーメッセージなどに多いため)", () => {
    expect(detectFormat("Error: something failed")).toBe("plain");
  });
});

describe("fence", () => {
  it("言語付きのコードブロックで包む", () => {
    expect(fence('{"a":1}', "json")).toBe('```json\n{"a":1}\n```');
  });

  it("本文に ``` があっても閉じられないよう、より長いフェンスを使う", () => {
    expect(fence("a\n```\nb", "text")).toBe("````text\na\n```\nb\n````");
  });
});

describe("toMarkdownSource", () => {
  const block = (kind: string, text: string) => ({ kind, text }) as Parameters<typeof toMarkdownSource>[0];

  it("ユーザー・Claude・思考はそのまま Markdown として扱う", () => {
    expect(toMarkdownSource(block("assistant", "**太字**"))).toEqual({ source: "**太字**", format: "markdown" });
    expect(toMarkdownSource(block("user", "hi")).format).toBe("markdown");
    expect(toMarkdownSource(block("thinking", "hmm")).format).toBe("markdown");
  });

  it("ツール使用は JSON のコードブロックにする", () => {
    expect(toMarkdownSource(block("tool_use", '{"a":1}'))).toEqual({ source: '```json\n{"a":1}\n```', format: "json" });
  });

  it("ツール結果が完全な JSON なら字下げして整形する (1 行に詰めた JSON も読めるように)", () => {
    expect(toMarkdownSource(block("tool_result", '{"a":1,"b":[2]}')).source).toBe(
      '```json\n{\n  "a": 1,\n  "b": [\n    2\n  ]\n}\n```',
    );
  });

  it("途中で切れた JSON は整形せずそのまま", () => {
    expect(toMarkdownSource(block("tool_result", '{"a":1,"b"')).source).toBe('```json\n{"a":1,"b"\n```');
  });

  it("ツール結果は判定した形式で表示する", () => {
    expect(toMarkdownSource(block("tool_result", "a: 1\nb: 2")).source).toBe("```yaml\na: 1\nb: 2\n```");
    expect(toMarkdownSource(block("tool_result", "# 見出し"))).toEqual({ source: "# 見出し", format: "markdown" });
    expect(toMarkdownSource(block("tool_result", "ok"))).toEqual({ source: "```text\nok\n```", format: "plain" });
  });
});

describe("splitUrls", () => {
  it("URL とそれ以外に分ける", () => {
    expect(splitUrls("see https://example.com/a?b=1 now")).toEqual([
      { text: "see " },
      { text: "https://example.com/a?b=1", url: "https://example.com/a?b=1" },
      { text: " now" },
    ]);
  });

  it("URL の後ろの句読点・閉じカッコ・全角文字はリンクに含めない", () => {
    expect(splitUrls("（https://example.com/x ）")[1]).toEqual({ text: "https://example.com/x", url: "https://example.com/x" });
    expect(splitUrls("https://example.com/x。次")[0].url).toBe("https://example.com/x");
    expect(splitUrls("(https://example.com/x).")[1].url).toBe("https://example.com/x");
    expect(splitUrls('"https://example.com/x",')[1].url).toBe("https://example.com/x");
  });

  it("URL が無ければ 1 つのまま", () => {
    expect(splitUrls("no link")).toEqual([{ text: "no link" }]);
  });
});
