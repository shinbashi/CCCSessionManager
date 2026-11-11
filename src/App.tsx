import { useCallback, useEffect, useMemo, useState } from "react";
import { Explorer } from "./components/Explorer";
import { SearchView } from "./components/SearchView";
import { SessionDetail } from "./components/SessionDetail";
import { UpdateBanner } from "./components/UpdateBanner";
import { listSessions, type SessionInfo } from "./sessions";

type Mode = "sessions" | "search";

function App() {
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  // 起動直後に空の一覧が一瞬見えないよう、読み込み中から始める
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<Mode>("sessions");
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [focusUuid, setFocusUuid] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setSessions(await listSessions());
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  const selected = useMemo(() => sessions.find((s) => s.path === selectedPath) ?? null, [sessions, selectedPath]);

  const open = (s: SessionInfo, uuid: string | null = null) => {
    setSelectedPath(s.path);
    setFocusUuid(uuid);
    setMode("sessions");
  };

  const openParent = (parentId: string) => {
    const parent = sessions.find((s) => s.kind === "main" && s.id === parentId);
    if (parent) open(parent);
  };

  return (
    <main className="flex h-screen flex-col bg-bg text-fg">
      {/* タイトルバーは Overlay なので、ヘッダーをドラッグ領域にし、左に信号機ボタン分の余白を取る (html の font-size が 13px なので rem ではなく px で指定) */}
      <header data-tauri-drag-region className="flex h-11 shrink-0 items-center gap-3 border-b border-line bg-panel pr-4 pl-[84px] select-none">
        <h1 data-tauri-drag-region className="text-sm font-bold tracking-wide">
          <span className="text-accent drop-shadow-[0_0_8px_var(--accent)]">CCC</span>SessionManager
        </h1>
        <nav className="flex overflow-hidden rounded border border-line text-xs">
          {(
            [
              ["sessions", "セッション"],
              ["search", "検索"],
            ] as [Mode, string][]
          ).map(([m, label]) => (
            <button
              key={m}
              type="button"
              onClick={() => setMode(m)}
              className={`px-3 py-1 ${mode === m ? "bg-accent/15 text-accent" : "text-dim hover:text-fg"}`}
            >
              {label}
            </button>
          ))}
        </nav>
        <button
          type="button"
          onClick={reload}
          disabled={loading}
          className="ml-auto rounded border border-line px-3 py-1 text-xs text-muted hover:border-accent hover:text-accent disabled:opacity-40"
        >
          {loading ? "読み込み中…" : "更新"}
        </button>
      </header>
      <UpdateBanner />

      {error && <p className="bg-danger/10 px-4 py-2 text-xs text-danger">{error}</p>}

      <div className="flex min-h-0 flex-1">
        <Explorer sessions={sessions} loading={loading} selectedPath={selectedPath} onSelect={(s) => open(s)} />

        {/* 検索結果を保つため、検索画面は隠すだけにする */}
        <div className={mode === "search" ? "flex min-w-0 flex-1" : "hidden"}>
          <SearchView sessions={sessions} onOpen={open} />
        </div>
        {mode === "sessions" &&
          (selected ? (
            <SessionDetail session={selected} focusUuid={focusUuid} onChanged={reload} onOpenParent={openParent} />
          ) : (
            <div className="flex flex-1 items-center justify-center text-sm text-dim">
              左のエクスプローラーからセッションを選んでください
            </div>
          ))}
      </div>
    </main>
  );
}

export default App;
