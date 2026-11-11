import { useVirtualizer } from "@tanstack/react-virtual";
import { useEffect, useMemo, useRef, useState } from "react";
import { BLOCK_KINDS, formatTime, kindInfo, loadFullBlock, loadTranscript, type Block, type BlockKind } from "../sessions";
import { fence, toMarkdownSource, type Format } from "../format";
import { Markdown } from "./Markdown";
import { Chip, KindBadge } from "./ui";

type Props = {
  path: string;
  /** 検索結果から開いたときに、ここまでスクロールする */
  focusUuid?: string | null;
};

type Order = "asc" | "desc";
const ORDER_KEY = "conversation-order";

function loadOrder(): Order {
  try {
    return localStorage.getItem(ORDER_KEY) === "desc" ? "desc" : "asc";
  } catch {
    return "asc";
  }
}

/** スクロール位置が端にあるとみなす余白 (px) */
const EDGE = 24;

export function ConversationView({ path, focusUuid }: Props) {
  const [blocks, setBlocks] = useState<Block[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [kinds, setKinds] = useState<Set<BlockKind>>(new Set(BLOCK_KINDS.map((k) => k.kind)));
  const scrollRef = useRef<HTMLDivElement>(null);
  // 「全文を表示」で読み込んだ全文 (seq → text)。仮想スクロールでカードが作り直されても保つため、ここで持つ
  const [fullTexts, setFullTexts] = useState<Map<number, string | null>>(new Map());
  const setFull = (seq: number, text: string | null) =>
    setFullTexts((cur) => {
      const next = new Map(cur);
      if (text === null) next.delete(seq);
      else next.set(seq, text);
      return next;
    });

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

  // 昇順 = 古い発言が上、降順 = 新しい発言が上
  const [order, setOrder] = useState<Order>(loadOrder);
  const changeOrder = (next: Order) => {
    setOrder(next);
    try {
      localStorage.setItem(ORDER_KEY, next);
    } catch {
      // 保存できなくても表示には影響しない
    }
  };

  const visible = useMemo(() => {
    const filtered = (blocks ?? []).filter((b) => kinds.has(b.kind));
    return order === "desc" ? filtered.reverse() : filtered;
  }, [blocks, kinds, order]);

  const virtualizer = useVirtualizer({
    count: visible.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 90,
    overscan: 8,
  });

  const scrollToTop = () => virtualizer.scrollToIndex(0, { align: "start" });
  const scrollToBottom = () => virtualizer.scrollToIndex(visible.length - 1, { align: "end" });

  // 開いたとき・並び順を変えたときは、最新の発言が見える位置へ (昇順なら一番下、降順なら一番上)。
  // 検索結果から来たときは該当ブロックへ
  const loaded = blocks !== null;
  useEffect(() => {
    if (!loaded || visible.length === 0) return;
    if (focusUuid) {
      const index = visible.findIndex((b) => b.uuid === focusUuid);
      if (index >= 0) virtualizer.scrollToIndex(index, { align: "center" });
      return;
    }
    if (order === "asc") virtualizer.scrollToIndex(visible.length - 1, { align: "end" });
    else virtualizer.scrollToIndex(0, { align: "start" });
    // 種類の絞り込みを変えたときに位置が飛ばないよう、visible は依存に入れない
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loaded, order, focusUuid]);

  // 端にいるときは、その方向へのボタンを隠す
  const [edge, setEdge] = useState({ top: true, bottom: true });
  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setEdge({ top: el.scrollTop <= EDGE, bottom: el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE });
  };
  // 読み込みや絞り込みで高さが変わったときも判定し直す
  const totalSize = virtualizer.getTotalSize();
  useEffect(onScroll, [visible, totalSize]);

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
        <button
          type="button"
          onClick={() => changeOrder(order === "asc" ? "desc" : "asc")}
          className="rounded border border-line px-2 py-0.5 text-xs whitespace-nowrap text-muted hover:bg-card-hover hover:text-fg"
          title={order === "asc" ? "古い発言が上 (クリックで新しい順)" : "新しい発言が上 (クリックで古い順)"}
        >
          {order === "asc" ? "↑ 昇順（古い順）" : "↓ 降順（新しい順）"}
        </button>
      </div>

      {error && <p className="px-4 py-2 text-xs text-danger">{error}</p>}
      {!blocks && !error && <p className="px-4 py-6 text-xs text-dim">会話を読み込み中…</p>}

      <div className="relative flex min-h-0 flex-1 flex-col">
        <div ref={scrollRef} onScroll={onScroll} className="min-h-0 flex-1 overflow-y-auto">
          <div style={{ height: totalSize, position: "relative" }}>
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
                  <BlockCard
                    block={b}
                    focused={!!focusUuid && b.uuid === focusUuid}
                    fullText={fullTexts.get(b.seq) ?? null}
                    onLoadFull={() => loadFullBlock(path, b).then((t) => setFull(b.seq, t))}
                    onCollapse={() => setFull(b.seq, null)}
                  />
                </div>
              );
            })}
          </div>
        </div>
        {blocks && !edge.top && (
          <JumpButton position="top" onClick={scrollToTop}>
            ↑ 最上部へ
          </JumpButton>
        )}
        {blocks && !edge.bottom && (
          <JumpButton position="bottom" onClick={scrollToBottom}>
            ↓ 最下部へ
          </JumpButton>
        )}
      </div>
    </div>
  );
}

/** ビューワの上下中央に重ねて出す移動ボタン */
function JumpButton({ position, onClick, children }: { position: "top" | "bottom"; onClick: () => void; children: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`absolute left-1/2 z-10 -translate-x-1/2 rounded-full border border-accent/60 bg-panel/90 px-3 py-1 text-xs text-accent shadow-glow-blue backdrop-blur hover:bg-accent/15 ${
        position === "top" ? "top-2" : "bottom-3"
      }`}
    >
      {children}
    </button>
  );
}

const FORMAT_LABEL: Record<Format, string> = { markdown: "Markdown", json: "JSON", yaml: "YAML", plain: "テキスト" };

type CardProps = {
  block: Block;
  focused: boolean;
  /** 読み込み済みの全文 (省略表示中は null) */
  fullText: string | null;
  onLoadFull: () => Promise<void>;
  onCollapse: () => void;
};

function BlockCard({ block, focused, fullText, onLoadFull, onCollapse }: CardProps) {
  const { color } = kindInfo(block.kind);
  const tool = block.kind === "tool_use" || block.kind === "tool_result";
  // 全文も省略表示と同じ経路 (形式の判定 → Markdown 描画) を通す
  const text = fullText ?? block.text;
  const { source, format } = useMemo(() => toMarkdownSource({ kind: block.kind, text }), [block.kind, text]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const loadFull = () => {
    setLoading(true);
    setLoadError(null);
    onLoadFull()
      .catch((e) => setLoadError(String(e)))
      .finally(() => setLoading(false));
  };
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
      <div
        className={`${tool ? (fullText ? "max-h-[70vh] overflow-y-auto" : "max-h-72 overflow-y-auto") : ""} ${
          block.kind === "thinking" ? "text-kind-thinking/90 italic" : ""
        }`}
      >
        {raw ? (
          <Markdown source={fence(text, "text")} className={tool ? "md-tool" : ""} />
        ) : (
          <Markdown source={source} className={tool ? "md-tool" : "text-[13px] leading-relaxed"} />
        )}
      </div>
      {block.truncated && (
        <div className="mt-1.5 flex items-center gap-2 text-[11px] text-dim">
          {fullText === null ? (
            <>
              <span>…（長いため省略しました）</span>
              <button
                type="button"
                disabled={loading}
                onClick={loadFull}
                className="rounded border border-line px-1.5 text-accent hover:bg-accent/10 disabled:opacity-50"
              >
                {loading ? "読み込み中…" : "全文を表示"}
              </button>
            </>
          ) : (
            <>
              <span>全文（{fullText.length.toLocaleString()} 文字）を表示しています</span>
              <button type="button" onClick={onCollapse} className="rounded border border-line px-1.5 hover:text-fg">
                折りたたむ
              </button>
            </>
          )}
          {loadError && <span className="text-danger">{loadError}</span>}
        </div>
      )}
    </div>
  );
}
