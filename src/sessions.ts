import { invoke } from "@tauri-apps/api/core";

// ---- Rust 側と同じ形の型 ----------------------------------------------------

export type CmuxLocation = { surfaceId: string; workspaceId: string };

export type SessionInfo = {
  /** jsonl のパス (一意のキー) */
  path: string;
  id: string;
  kind: "main" | "subagent";
  parentSessionId: string | null;
  agentType: string | null;
  projectDir: string;
  cwd: string | null;
  title: string | null;
  lastPrompt: string | null;
  /** ISO 8601 */
  createdAt: string | null;
  /** ミリ秒 */
  updatedAt: number;
  live: { pid: number; status: string; memoryKb: number | null } | null;
  cmux: CmuxLocation | null;
  /** アプリが休止させた (同じタブで再開できる) */
  suspended: boolean;
};

export type BlockKind = "user" | "assistant" | "thinking" | "tool_use" | "tool_result";

export type Block = {
  kind: BlockKind;
  text: string;
  toolName: string | null;
  timestamp: string | null;
  uuid: string | null;
  truncated: boolean;
};

export type Hit = {
  path: string;
  kind: BlockKind;
  snippet: string;
  toolName: string | null;
  timestamp: string | null;
  uuid: string | null;
};

export type SearchResult = { hits: Hit[]; total: number };

// ---- Rust の呼び出し ---------------------------------------------------------

export const listSessions = () => invoke<SessionInfo[]>("list_sessions");
export const loadTranscript = (path: string) => invoke<Block[]>("load_transcript", { path });
export const searchMessages = (query: string, kinds: BlockKind[], limit = 500) =>
  invoke<SearchResult>("search_messages", { query, kinds, limit });
export const focusSession = (c: CmuxLocation) =>
  invoke<void>("focus_session", { workspaceId: c.workspaceId, surfaceId: c.surfaceId });
/** cmux で休止できれば "cmux"、cmux が拒否してアプリが止めたら "suspended" */
export const hibernateSession = (s: SessionInfo) =>
  invoke<"cmux" | "suspended">("hibernate_session", {
    workspaceId: s.cmux!.workspaceId,
    surfaceId: s.cmux!.surfaceId,
    pid: s.live!.pid,
    sessionId: s.id,
  });
/** アプリが休止させたセッションを、同じ cmux タブで再開する */
export const resumeSession = (s: SessionInfo) =>
  invoke<void>("resume_session", {
    workspaceId: s.cmux!.workspaceId,
    surfaceId: s.cmux!.surfaceId,
    sessionId: s.id,
    cwd: s.cwd,
  });
export const terminateSession = (pid: number) => invoke<void>("terminate_session", { pid });

// ---- 表示用の定義 ------------------------------------------------------------

export const BLOCK_KINDS: { kind: BlockKind; label: string; color: string }[] = [
  { kind: "user", label: "ユーザー", color: "var(--kind-user)" },
  { kind: "assistant", label: "Claude", color: "var(--kind-assistant)" },
  { kind: "thinking", label: "思考", color: "var(--kind-thinking)" },
  { kind: "tool_use", label: "ツール使用", color: "var(--kind-tool-use)" },
  { kind: "tool_result", label: "ツール結果", color: "var(--kind-tool-result)" },
];
export const kindInfo = (k: BlockKind) => BLOCK_KINDS.find((b) => b.kind === k)!;

/** 実行状態: 実行中(busy/idle) > アプリが休止させた > cmux に残っている > 終了 */
export type LiveState = "busy" | "idle" | "suspended" | "cmux" | "closed";
export function liveState(s: SessionInfo): LiveState {
  if (s.live) return s.live.status === "busy" ? "busy" : "idle";
  if (s.suspended) return "suspended";
  return s.cmux ? "cmux" : "closed";
}
export const LIVE_LABEL: Record<LiveState, string> = {
  busy: "busy",
  idle: "idle",
  suspended: "休止中",
  cmux: "停止中",
  closed: "終了",
};

/** 「3分前」「2日前」のような相対表示 */
export function formatAgo(ms: number, now = Date.now()): string {
  const min = Math.floor((now - ms) / 60_000);
  if (min < 1) return "たった今";
  if (min < 60) return `${min}分前`;
  const hours = Math.floor(min / 60);
  if (hours < 24) return `${hours}時間前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}日前`;
  return new Date(ms).toLocaleDateString("ja-JP");
}

export const formatTime = (iso: string | null) =>
  iso ? new Date(iso).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }) : "";

export const formatMemory = (kb: number | null | undefined) =>
  kb == null ? "" : kb >= 1024 * 1024 ? `${(kb / 1024 / 1024).toFixed(1)} GB` : `${Math.round(kb / 1024)} MB`;

/** /Users/<name>/... を ~/... に短縮する */
export const shortenHome = (path: string) => path.replace(/^\/Users\/[^/]+/, "~");

/** フォルダ別表示のキー: 作業ディレクトリ (無ければ projects 直下の名前) */
export const folderOf = (s: SessionInfo) => s.cwd ?? s.projectDir;

export const titleOf = (s: SessionInfo) => s.title ?? "（タイトルなし）";

export const resumeCommand = (s: SessionInfo) =>
  `cd '${(s.cwd ?? "~").replace(/'/g, "'\\''")}' && claude --resume ${s.id}`;

// ---- 並べ替え・絞り込み ------------------------------------------------------

export type SortKey = "updated" | "created" | "title" | "live" | "folder" | "memory";
export const SORT_LABEL: Record<SortKey, string> = {
  updated: "最終更新",
  created: "作成日時",
  title: "タイトル",
  live: "実行状態",
  folder: "フォルダ",
  memory: "メモリ",
};

const LIVE_ORDER: Record<LiveState, number> = { busy: 0, idle: 1, suspended: 2, cmux: 3, closed: 4 };

/** 昇順の比較関数 (降順は呼び出し側で反転する) */
const COMPARE: Record<SortKey, (a: SessionInfo, b: SessionInfo) => number> = {
  updated: (a, b) => a.updatedAt - b.updatedAt,
  created: (a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
  title: (a, b) => titleOf(a).localeCompare(titleOf(b), "ja"),
  live: (a, b) => LIVE_ORDER[liveState(a)] - LIVE_ORDER[liveState(b)],
  folder: (a, b) => folderOf(a).localeCompare(folderOf(b)),
  memory: (a, b) => (a.live?.memoryKb ?? -1) - (b.live?.memoryKb ?? -1),
};

export function sortSessions(rows: SessionInfo[], key: SortKey, desc: boolean): SessionInfo[] {
  const cmp = COMPARE[key];
  // 同順位は最終更新の新しい順にそろえる
  return [...rows].sort((a, b) => (desc ? -cmp(a, b) : cmp(a, b)) || b.updatedAt - a.updatedAt);
}

export type KindFilter = "main" | "subagent" | "all";
export type Filters = { kind: KindFilter; liveOnly: boolean; text: string };

export function filterSessions(rows: SessionInfo[], f: Filters): SessionInfo[] {
  const text = f.text.trim().toLowerCase();
  return rows.filter(
    (s) =>
      (f.kind === "all" || s.kind === f.kind) &&
      (!f.liveOnly || s.live != null) &&
      (!text ||
        [s.title, s.lastPrompt, s.cwd, s.id, s.agentType].some((v) => v?.toLowerCase().includes(text))),
  );
}

/** フォルダ別にまとめる。フォルダは中身の並び順の先頭が早い順 */
export function groupByFolder(sorted: SessionInfo[]): { folder: string; sessions: SessionInfo[] }[] {
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sorted) {
    const key = folderOf(s);
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups].map(([folder, sessions]) => ({ folder, sessions }));
}
