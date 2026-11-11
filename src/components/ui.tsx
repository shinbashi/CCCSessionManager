import type { ButtonHTMLAttributes, ReactNode } from "react";
import { kindInfo, LIVE_LABEL, liveState, type BlockKind, type SessionInfo } from "../sessions";

/** 発言の種類のラベル (色付き) */
export function KindBadge({ kind, toolName }: { kind: BlockKind; toolName?: string | null }) {
  const { label, color } = kindInfo(kind);
  return (
    <span
      className="inline-flex shrink-0 items-center gap-1 rounded px-1.5 py-0.5 text-xs font-semibold"
      style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)`, border: `1px solid color-mix(in oklch, ${color} 40%, transparent)` }}
    >
      {label}
      {toolName && <span className="font-mono font-normal opacity-80">{toolName}</span>}
    </span>
  );
}

const LIVE_STYLE = {
  busy: "text-success border-success/50 bg-success/10 shadow-glow-green",
  idle: "text-info border-info/40 bg-info/10",
  suspended: "text-kind-tool-use border-kind-tool-use/50 bg-kind-tool-use/10",
  cmux: "text-warning border-warning/40 bg-warning/10",
  closed: "text-dim border-line",
} as const;

/** 実行状態のバッジ */
export function LiveBadge({ session }: { session: SessionInfo }) {
  const state = liveState(session);
  return (
    <span className={`shrink-0 rounded border px-1.5 py-px text-[11px] font-semibold ${LIVE_STYLE[state]}`}>
      {LIVE_LABEL[state]}
    </span>
  );
}

export function SubagentBadge({ session }: { session: SessionInfo }) {
  if (session.kind !== "subagent") return null;
  return (
    <span className="shrink-0 rounded border border-kind-tool-use/40 px-1.5 py-px text-[11px] text-kind-tool-use">
      {session.agentType ?? "subagent"}
    </span>
  );
}

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & { tone?: "default" | "accent" | "danger"; children: ReactNode };

export function Button({ tone = "default", className = "", ...rest }: ButtonProps) {
  const toneClass = {
    default: "border-line text-muted hover:bg-card-hover hover:text-fg",
    accent: "border-accent/60 text-accent hover:bg-accent/10 hover:shadow-glow-blue",
    danger: "border-danger/60 text-danger hover:bg-danger/10",
  }[tone];
  return (
    <button
      type="button"
      className={`rounded border px-2.5 py-1 text-xs transition disabled:cursor-not-allowed disabled:opacity-40 ${toneClass} ${className}`}
      {...rest}
    />
  );
}

/** 読み込み中を示すネオン調の回転する輪 (視差効果を減らす設定では回さない) */
export function Spinner({ size = 28 }: { size?: number }) {
  return (
    <span
      role="status"
      aria-label="読み込み中"
      className="inline-block animate-spin rounded-full border-2 border-accent/20 border-t-accent shadow-glow-blue motion-reduce:animate-none"
      style={{ width: size, height: size }}
    />
  );
}

/** 中身を読み込んでいる間、空のペインの中央に出す */
export function LoadingPane({ label }: { label: string }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 py-10 text-xs text-dim">
      <Spinner />
      <span className="animate-pulse motion-reduce:animate-none">{label}</span>
    </div>
  );
}

/** 選択式の小さなトグル */
export function Chip({ active, color, onClick, children }: { active: boolean; color?: string; onClick: () => void; children: ReactNode }) {
  const c = color ?? "var(--accent)";
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded-full border px-2 py-0.5 text-xs transition"
      style={
        active
          ? { color: c, borderColor: `color-mix(in oklch, ${c} 60%, transparent)`, background: `color-mix(in oklch, ${c} 14%, transparent)` }
          : { color: "var(--dim)", borderColor: "var(--border)" }
      }
    >
      {children}
    </button>
  );
}
