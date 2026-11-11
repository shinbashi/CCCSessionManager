import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { BLOCK_KINDS, formatTime, kindInfo, loadTranscript, type Block, type BlockKind } from "../sessions";
import { fence, toMarkdownSource, type Format } from "../format";
import { Markdown } from "./Markdown";
import { Chip, KindBadge } from "./ui";

type Props = {
  path: string;
  /** 検索結果から開いたときに、ここまでスクロールする */
  focusUuid?: string | null;
};

export function ConversationView({ path, focusUuid }: Props) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<BlockKind>>(new Set(BLOCK_KINDS.map((k) => k.kind)));
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let cancelled = false;
    setBlocks(null);
    setError(null);
    loadTranscript(path)
      .then((b) => !cancelled && setBlocks(b))
      .catch((e) => !cancelled && setError(String(e)));
    return () => {
      cancelled = true;
    };
  }, [path]);

  const counts = useMemo(() => {
    const c = new Map<BlockKind, number>();
    for (const b of blocks ?? []) c.set(b.kind, (c.get(b.kind) ?? 0) + 1);
    return c;
  }, [blocks]);

  const visible = useMemo(() => (blocks ?? []).filter((b) => kinds.has(b.kind)), [blocks, kinds]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 90,
    overscan: 8,
  });

  // 検索結果から来たときは該当ブロックへ
  useEffect(() => {
    if (!focusUuid || visible.length === 0) return;
    const index = visible.findIndex((b) => b.uuid === focusUuid);
    if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
  }, [focusUuid, visible, virtualizer]);

  const toggle = (k: BlockKind) =>
    setKinds((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-4 py-2">
        {BLOCK_KINDS.map(({ kind, label, color }) => (
          <Chip key={kind} active={kinds.has(kind)} color={color} onClick={() => toggle(kind)}>
            {label} {counts.get(kind) ?? 0}
          </Chip>
        ))}
        <span className="ml-auto text-xs text-dim">{blocks ? `${visible.length} 件表示` : ""}</span>
      </div>

      {error && <p className="px-4 py-2 text-xs text-danger">{error}</p>}
      {!blocks && !error && <p className="px-4 py-6 text-xs text-dim">会話を読み込み中…</p>}

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
        <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
          {virtualizer.getVirtualItems().map((item) => {
            const b = visible[item.index];
            return (
              <div
                key={item.key}
                data-index={item.index}
                ref={virtualizer.measureElement}
                className="absolute inset-x-0 px-4 py-1.5"
                style={{ transform: `translateY(${item.start}px)` }}
              >
                <BlockCard block={b} focused={!!focusUuid && b.uuid === focusUuid} />
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

const FORMAT_LABEL: Record<Format, string> = { markdown: "Markdown", json: "JSON", yaml: "YAML", plain: "テキスト" };

function BlockCard({ block, focused }: { block: Block; focused: boolean }) {
  const { color } = kindInfo(block.kind);
  const tool = block.kind === "tool_use" || block.kind === "tool_result";
  const { source, format } = useMemo(() => toMarkdownSource(block), [block]);
  // 自動判定が外れたときのために、原文 (整形しない表示) に切り替えられるようにする
  const [raw, setRaw] = useState(false);
  return (
    <div
      className={`group rounded-md border border-line bg-card px-3 py-2 ${focused ? "neon-ring" : ""}`}
      style={{ borderLeft: `3px solid ${color}`, boxShadow: focused ? undefined : `inset 0 0 24px -16px ${color}` }}
    >
      <div className="mb-1 flex items-center gap-2">
        <KindBadge kind={block.kind} toolName={block.toolName} />
        <span className="text-[11px] text-dim">{formatTime(block.timestamp)}</span>
        {format !== "plain" && (
          <button
            type="button"
            onClick={() => setRaw((r) => !r)}
            // 発言 (Markdown と分かりきっている) はマウスを乗せたときだけ出す
            className={`ml-auto rounded border border-line px-1.5 text-[11px] text-dim hover:text-fg ${
              tool || raw ? "" : "opacity-0 group-hover:opacity-100"
            }`}
            title="整形した表示と原文を切り替えます"
          >
            {raw ? "原文" : FORMAT_LABEL[format]}
          </button>
        )}
      </div>
      <div className={`${tool ? "max-h-72 overflow-y-auto" : ""} ${block.kind === "thinking" ? "text-kind-thinking/90 italic" : ""}`}>
        {raw ? (
          <Markdown source={fence(block.text, "text")} className={tool ? "md-tool" : ""} />
        ) : (
          <Markdown source={source} className={tool ? "md-tool" : "text-[13px] leading-relaxed"} />
        )}
      </div>
      {block.truncated && <div className="mt-1 text-[11px] text-dim">…（長いため省略しました）</div>}
    </div>
  );
}
