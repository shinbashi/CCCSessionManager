import { useEffect, useMemo, useState } from "react";
import {
  filterSessions,
  folderOf,
  formatAgo,
  formatMemory,
  groupByFolder,
  shortenHome,
  SORT_LABEL,
  sortSessions,
  titleOf,
  type Filters,
  type KindFilter,
  type SessionInfo,
  type SortKey,
} from "../sessions";
import { Chip, LiveBadge, SubagentBadge } from "./ui";

type View = "list" | "folder";
type Prefs = { view: View; sort: SortKey; desc: boolean; kind: KindFilter; liveOnly: boolean };

const DEFAULT_PREFS: Prefs = { view: "folder", sort: "updated", desc: true, kind: "main", liveOnly: false };
const PREFS_KEY = "explorer-prefs";

function loadPrefs(): Prefs {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") };
  } catch {
    return DEFAULT_PREFS;
  }
}

type Props = {
  sessions: SessionInfo[];
  selectedPath: string | null;
  onSelect: (s: SessionInfo) => void;
};

export function Explorer({ sessions, selectedPath, onSelect }: Props) {
  const [prefs, setPrefs] = useState<Prefs>(loadPrefs);
  const [text, setText] = useState("");
  const [openFolders, setOpenFolders] = useState<Set<string>>(new Set());

  useEffect(() => {
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
    } catch {
      /* 保存できなくても動作には影響しない */
    }
  }, [prefs]);

  const update = (p: Partial<Prefs>) => setPrefs((cur) => ({ ...cur, ...p }));

  const visible = useMemo(() => {
    const filters: Filters = { kind: prefs.kind, liveOnly: prefs.liveOnly, text };
    return sortSessions(filterSessions(sessions, filters), prefs.sort, prefs.desc);
  }, [sessions, prefs, text]);

  const groups = useMemo(() => groupByFolder(visible), [visible]);
  const liveCount = sessions.filter((s) => s.live).length;

  const toggleFolder = (f: string) =>
    setOpenFolders((cur) => {
      const next = new Set(cur);
      if (next.has(f)) next.delete(f);
      else next.add(f);
      return next;
    });

  return (
    <aside className="flex h-full w-[380px] shrink-0 flex-col border-r border-line bg-panel">
      <div className="space-y-2 border-b border-line p-3">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold tracking-wider text-accent uppercase">Explorer</span>
          <span className="text-xs whitespace-nowrap text-dim">
            {visible.length} / {sessions.length} 件・実行中 <span className="text-success">{liveCount}</span>
          </span>
          <div className="ml-auto flex overflow-hidden rounded border border-line text-xs">
            {(["list", "folder"] as View[]).map((v) => (
              <button
                key={v}
                type="button"
                onClick={() => update({ view: v })}
                className={`px-2 py-0.5 whitespace-nowrap ${prefs.view === v ? "bg-accent/15 text-accent" : "text-dim hover:text-fg"}`}
              >
                {v === "list" ? "一覧" : "フォルダ別"}
              </button>
            ))}
          </div>
        </div>

        <input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="タイトル・指示・フォルダで絞り込み"
          className="w-full rounded border border-line bg-bg px-2 py-1 text-xs outline-none focus:border-accent"
        />

        <div className="flex items-center gap-1.5">
          <select
            value={prefs.sort}
            onChange={(e) => update({ sort: e.target.value as SortKey })}
            className="rounded border border-line bg-bg px-1.5 py-0.5 text-xs text-muted outline-none"
          >
            {(Object.keys(SORT_LABEL) as SortKey[]).map((k) => (
              <option key={k} value={k}>
                {SORT_LABEL[k]}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={() => update({ desc: !prefs.desc })}
            className="rounded border border-line px-1.5 py-0.5 text-xs text-muted hover:text-fg"
            title="並び順を反転"
          >
            {prefs.desc ? "↓ 降順" : "↑ 昇順"}
          </button>
          <Chip active={prefs.liveOnly} color="var(--success)" onClick={() => update({ liveOnly: !prefs.liveOnly })}>
            実行中のみ
          </Chip>
        </div>

        <div className="flex gap-1.5">
          {(
            [
              ["main", "通常"],
              ["subagent", "サブエージェント"],
              ["all", "すべて"],
            ] as [KindFilter, string][]
          ).map(([k, label]) => (
            <Chip key={k} active={prefs.kind === k} onClick={() => update({ kind: k })}>
              {label}
            </Chip>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto">
        {prefs.view === "list"
          ? visible.map((s) => (
              <SessionItem key={s.path} s={s} selected={s.path === selectedPath} onSelect={onSelect} showFolder />
            ))
          : groups.map(({ folder, sessions: items }) => {
              const open = openFolders.has(folder) || items.some((s) => s.path === selectedPath);
              const live = items.filter((s) => s.live).length;
              return (
                <div key={folder}>
                  <button
                    type="button"
                    onClick={() => toggleFolder(folder)}
                    className="flex w-full items-center gap-2 border-b border-line/60 px-3 py-1.5 text-left hover:bg-card-hover"
                    title={folder}
                  >
                    <span className="w-3 text-[11px] text-dim">{open ? "▼" : "▶"}</span>
                    <span className="truncate text-xs font-medium">{folderName(folder)}</span>
                    <span className="truncate text-[11px] text-dim">{shortenHome(folder)}</span>
                    <span className="ml-auto shrink-0 text-[11px] text-dim">
                      {live > 0 && <span className="mr-1 text-success">●{live}</span>}
                      {items.length}
                    </span>
                  </button>
                  {open &&
                    items.map((s) => (
                      <SessionItem key={s.path} s={s} selected={s.path === selectedPath} onSelect={onSelect} indent />
                    ))}
                </div>
              );
            })}
      </div>
    </aside>
  );
}

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function SessionItem({
  s,
  selected,
  onSelect,
  showFolder,
  indent,
}: {
  s: SessionInfo;
  selected: boolean;
  onSelect: (s: SessionInfo) => void;
  showFolder?: boolean;
  indent?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(s)}
      className={`block w-full border-b border-line/40 py-1.5 pr-3 text-left transition ${indent ? "pl-8" : "pl-3"} ${
        selected ? "neon-ring bg-accent/10" : "hover:bg-card-hover"
      }`}
    >
      <div className="truncate text-xs font-medium" title={titleOf(s)}>
        {titleOf(s)}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5 text-[11px] text-dim">
        <LiveBadge session={s} />
        <SubagentBadge session={s} />
        <span className="shrink-0 whitespace-nowrap">{formatAgo(s.updatedAt)}</span>
        {s.live?.memoryKb != null && <span className="shrink-0 whitespace-nowrap text-muted">{formatMemory(s.live.memoryKb)}</span>}
        {showFolder && <span className="min-w-0 truncate">{shortenHome(folderOf(s))}</span>}
      </div>
    </button>
  );
}
