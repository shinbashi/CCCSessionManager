import { useMemo, useState } from "react";
import {
  BLOCK_KINDS,
  formatTime,
  searchMessages,
  shortenHome,
  titleOf,
  type BlockKind,
  type Hit,
  type KindFilter,
  type SessionInfo,
} from "../sessions";
import { Button, Chip, KindBadge, LiveBadge, LoadingPane, SubagentBadge } from "./ui";

type Props = {
  sessions: SessionInfo[];
  onOpen: (s: SessionInfo, uuid: string | null) => void;
};

export function SearchView({ sessions, onOpen }: Props) {
  const [query, setQuery] = useState("");
  const [kinds, setKinds] = useState<Set<BlockKind>>(new Set(BLOCK_KINDS.map((k) => k.kind)));
  const [sessionKind, setSessionKind] = useState<KindFilter>("all");
  const [liveOnly, setLiveOnly] = useState(false);
  const [result, setResult] = useState<{ hits: Hit[]; total: number; query: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const byPath = useMemo(() => new Map(sessions.map((s) => [s.path, s])), [sessions]);

  const search = async () => {
    const q = query.trim();
    if (!q) return;
    setLoading(true);
    setError(null);
    try {
      const r = await searchMessages(q, [...kinds]);
      setResult({ ...r, query: q });
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  };

  const toggleKind = (k: BlockKind) =>
    setKinds((cur) => {
      const next = new Set(cur);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });

  const visible = (result?.hits ?? []).filter((h) => {
    const s = byPath.get(h.path);
    if (!s) return false;
    return (sessionKind === "all" || s.kind === sessionKind) && (!liveOnly || s.live != null);
  });

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line px-4 py-3">
        <form
          className="flex gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            search();
          }}
        >
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="全セッションの会話を検索（Enter）"
            className="flex-1 rounded border border-line bg-bg px-3 py-1.5 text-sm outline-none focus:border-accent focus:shadow-glow-blue"
          />
          <Button tone="accent" type="submit" disabled={loading || !query.trim() || kinds.size === 0}>
            {loading ? "検索中…" : "検索"}
          </Button>
        </form>

        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-dim">種類</span>
          {BLOCK_KINDS.map(({ kind, label, color }) => (
            <Chip key={kind} active={kinds.has(kind)} color={color} onClick={() => toggleKind(kind)}>
              {label}
            </Chip>
          ))}
          <span className="ml-3 text-xs text-dim">セッション</span>
          {(
            [
              ["all", "すべて"],
              ["main", "通常"],
              ["subagent", "サブエージェント"],
            ] as [KindFilter, string][]
          ).map(([k, label]) => (
            <Chip key={k} active={sessionKind === k} onClick={() => setSessionKind(k)}>
              {label}
            </Chip>
          ))}
          <Chip active={liveOnly} color="var(--success)" onClick={() => setLiveOnly(!liveOnly)}>
            実行中のみ
          </Chip>
        </div>

        {result && (
          <p className="text-xs text-dim">
            「{result.query}」{result.total.toLocaleString()} 件ヒット
            {result.total > result.hits.length && `（新しい ${result.hits.length} 件を表示）`}・絞り込み後 {visible.length} 件
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
        {loading && <LoadingPane label="すべての会話を検索中…" />}
        {!loading && visible.map((h, i) => {
          const s = byPath.get(h.path)!;
          return (
            <button
              key={`${h.path}-${h.uuid}-${i}`}
              type="button"
              onClick={() => onOpen(s, h.uuid)}
              className="block w-full border-b border-line/50 px-4 py-2 text-left hover:bg-card-hover"
            >
              <div className="flex items-center gap-2">
                <KindBadge kind={h.kind} toolName={h.toolName} />
                <span className="truncate text-xs font-medium">{titleOf(s)}</span>
                <LiveBadge session={s} />
                <SubagentBadge session={s} />
                <span className="ml-auto shrink-0 text-[11px] text-dim">{formatTime(h.timestamp)}</span>
              </div>
              <div className="mt-1 text-xs break-words text-muted">
                <Highlight text={h.snippet} query={result?.query ?? ""} />
              </div>
              <div className="mt-0.5 truncate font-mono text-[11px] text-dim">{shortenHome(s.cwd ?? s.projectDir)}</div>
            </button>
          );
        })}
      </div>
    </section>
  );
}

/** 一致箇所を光らせる (英字の大文字小文字は区別しない) */
function Highlight({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "i"));
  return (
    <>
      {parts.map((p, i) =>
        p.toLowerCase() === query.toLowerCase() ? (
          <mark key={i} className="rounded bg-warning/25 px-0.5 text-warning shadow-glow-amber">
            {p}
          </mark>
        ) : (
          <span key={i}>{p}</span>
        ),
      )}
    </>
  );
}
