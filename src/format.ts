import type { Block } from "./sessions";

/** 表示形式。plain は整形しない (ただしリンクは付ける) */
export type Format = "markdown" | "json" | "yaml" | "plain";

const YAML_LINE = /^\s*(- |[\w.-]+:(\s|$))/;
const MARKDOWN_HINT = /^(#{1,6} |```|\s*[-*] |\s*\d+\. |\|.*\|\s*$|> )/m;

/** ツール結果の中身から形式を推定する。途中で切り詰められた JSON も JSON とみなす */
export function detectFormat(text: string): Format {
  const t = text.trimStart();
  if (t.startsWith("{") || t.startsWith("[")) return "json";
  if (t.startsWith("---\n")) return "yaml";
  if (MARKDOWN_HINT.test(t) && !looksLikeYaml(t)) return "markdown";
  if (looksLikeYaml(t)) return "yaml";
  return "plain";
}

/** 空行以外の 2 行以上が key: value / - item で、その割合が 8 割以上 */
function looksLikeYaml(text: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (lines.length < 2) return false;
  const hits = lines.filter((l) => YAML_LINE.test(l)).length;
  return hits / lines.length >= 0.8 && lines.some((l) => /^\s*[\w.-]+:/.test(l));
}

/** 本文中のどのバッククォート列よりも長いフェンスでコードブロックにする */
export function fence(text: string, lang: string): string {
  const longest = Math.max(0, ...(text.match(/`+/g) ?? []).map((m) => m.length));
  const f = "`".repeat(Math.max(3, longest + 1));
  return `${f}${lang}\n${text}\n${f}`;
}

/** 完全な JSON なら字下げして整形する。途中で切れているなどでパースできなければそのまま */
function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

/** 発言を、react-markdown に渡す Markdown 文字列にする */
export function toMarkdownSource(block: Pick<Block, "kind" | "text">): { source: string; format: Format } {
  switch (block.kind) {
    case "user":
    case "assistant":
    case "thinking":
      return { source: block.text, format: "markdown" };
    case "tool_use":
      return { source: fence(block.text, "json"), format: "json" };
    case "tool_result": {
      const format = detectFormat(block.text);
      if (format === "markdown") return { source: block.text, format };
      if (format === "json") return { source: fence(prettyJson(block.text), "json"), format };
      return { source: fence(block.text, format === "plain" ? "text" : format), format };
    }
  }
}

// 全角文字は URL に含めない。後ろに付きやすい句読点・閉じカッコ・引用符はリンクから外す
const URL_RE = /https?:\/\/[\x21-\x7e]+/g;
const TRAILING = /[.,;:!?)\]}'"`>]$/;

export type Segment = { text: string; url?: string };

/** テキストを URL とそれ以外に分ける */
export function splitUrls(text: string): Segment[] {
  const out: Segment[] = [];
  let last = 0;
  for (const m of text.matchAll(URL_RE)) {
    let url = m[0];
    while (TRAILING.test(url)) {
      // 対応する ( がある ) は URL の一部 (Wikipedia の URL など)
      if (url.endsWith(")") && count(url, "(") >= count(url, ")")) break;
      url = url.slice(0, -1);
    }
    const start = m.index!;
    if (start > last) out.push({ text: text.slice(last, start) });
    out.push({ text: url, url });
    last = start + url.length;
  }
  if (last < text.length) out.push({ text: text.slice(last) });
  return out.length ? out : [{ text }];
}

const count = (s: string, ch: string) => s.split(ch).length - 1;
