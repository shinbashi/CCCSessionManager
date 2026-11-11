import { openUrl } from "@tauri-apps/plugin-opener";
import type { Element, ElementContent, Root } from "hast";
import bash from "highlight.js/lib/languages/bash";
import css from "highlight.js/lib/languages/css";
import diff from "highlight.js/lib/languages/diff";
import javascript from "highlight.js/lib/languages/javascript";
import json from "highlight.js/lib/languages/json";
import python from "highlight.js/lib/languages/python";
import rust from "highlight.js/lib/languages/rust";
import sql from "highlight.js/lib/languages/sql";
import typescript from "highlight.js/lib/languages/typescript";
import xml from "highlight.js/lib/languages/xml";
import yaml from "highlight.js/lib/languages/yaml";
import { memo } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import { splitUrls } from "../format";

/** 色分けする言語。よく出るものだけに絞ってバンドルを小さくする */
const LANGUAGES = { bash, css, diff, javascript, json, python, rust, sql, typescript, xml, yaml };
const ALIASES = { bash: ["sh", "shell", "zsh", "console"], javascript: ["js", "jsx"], typescript: ["ts", "tsx"], xml: ["html"], yaml: ["yml"] };

/** コードブロックの中なども含め、テキストに書かれた URL をリンクにする (既存の <a> の中は除く) */
function rehypeLinkify() {
  const walk = (node: Root | Element) => {
    if (node.type === "element" && node.tagName === "a") return;
    node.children = node.children.flatMap((child): ElementContent[] => {
      if (child.type === "element") {
        walk(child);
        return [child];
      }
      if (child.type !== "text" || !child.value.includes("http")) return [child as ElementContent];
      return splitUrls(child.value).map((seg) =>
        seg.url
          ? { type: "element", tagName: "a", properties: { href: seg.url }, children: [{ type: "text", value: seg.text }] }
          : { type: "text", value: seg.text },
      );
    }) as typeof node.children;
  };
  return (tree: Root) => walk(tree);
}

/** リンクはアプリ内では開かず、既定のブラウザで開く */
const components: Components = {
  a: ({ href, children }) => (
    <a
      href={href}
      title={href}
      onClick={(e) => {
        e.preventDefault();
        if (href && /^https?:\/\//.test(href)) openUrl(href).catch(console.error);
      }}
    >
      {children}
    </a>
  ),
};

/**
 * Markdown を描画する。生の HTML は解釈せず文字として表示する (react-markdown の既定)。
 * ログには任意の文字列が入るため、rehype-raw は使わないこと。
 */
export const Markdown = memo(function Markdown({ source, className = "" }: { source: string; className?: string }) {
  return (
    <div className={`md ${className}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={[[rehypeHighlight, { languages: LANGUAGES, aliases: ALIASES, detect: false, plainText: ["text"] }], rehypeLinkify]}
        components={components}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
