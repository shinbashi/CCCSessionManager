import { useState } from "react";
import {
  focusSession,
  formatAgo,
  formatMemory,
  formatTime,
  hibernateSession,
  resumeCommand,
  resumeSession,
  shortenHome,
  terminateSession,
  titleOf,
  type SessionInfo,
} from "../sessions";
import { ConversationView } from "./ConversationView";
import { Button, LiveBadge, SubagentBadge } from "./ui";

type Props = {
  session: SessionInfo;
  focusUuid?: string | null;
  /** 休止・終了のあとに一覧を読み直す */
  onChanged: () => void;
  onOpenParent: (parentId: string) => void;
};

export function SessionDetail({ session: s, focusUuid, onChanged, onOpenParent }: Props) {
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [confirmKill, setConfirmKill] = useState(false);
  const [busy, setBusy] = useState(false);

  const run = async (action: () => Promise<unknown>, done: string, refresh = false) => {
    setBusy(true);
    setMessage(null);
    try {
      await action();
      // done が空のときは action 側でメッセージを出している
      if (done) setMessage({ tone: "ok", text: done });
      if (refresh) onChanged();
    } catch (e) {
      setMessage({ tone: "error", text: String(e) });
    } finally {
      setBusy(false);
      setConfirmKill(false);
    }
  };

  const copyResume = () =>
    run(() => navigator.clipboard.writeText(resumeCommand(s)), "再開コマンドをコピーしました");

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div className="space-y-2 border-b border-line px-4 py-3">
        <div className="flex items-start gap-2">
          <h2 className="min-w-0 flex-1 text-base font-semibold break-words">{titleOf(s)}</h2>
          <LiveBadge session={s} />
          <SubagentBadge session={s} />
        </div>

        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-[11px]">
          <dt className="text-dim">フォルダ</dt>
          <dd className="truncate font-mono text-muted">{shortenHome(s.cwd ?? s.projectDir)}</dd>
          <dt className="text-dim">セッション</dt>
          <dd className="truncate font-mono text-muted">{s.id}</dd>
          <dt className="text-dim">作成 / 更新</dt>
          <dd className="text-muted">
            {formatTime(s.createdAt)} / {formatAgo(s.updatedAt)}
          </dd>
          {s.live && (
            <>
              <dt className="text-dim">プロセス</dt>
              <dd className="text-muted">
                PID {s.live.pid}・メモリ <span className="text-fg">{formatMemory(s.live.memoryKb)}</span>（MCP などの子プロセスを含む）
              </dd>
            </>
          )}
          {s.lastPrompt && (
            <>
              <dt className="text-dim">最後の指示</dt>
              <dd className="truncate text-muted" title={s.lastPrompt}>
                {s.lastPrompt}
              </dd>
            </>
          )}
        </dl>

        <div className="flex flex-wrap items-center gap-2">
          {s.suspended && s.cmux ? (
            <Button
              tone="accent"
              disabled={busy}
              onClick={() =>
                run(
                  async () => {
                    await resumeSession(s);
                    await focusSession(s.cmux!);
                  },
                  "同じタブで再開しました",
                  true,
                )
              }
              title="休止したときの cmux タブで claude --resume を実行します"
            >
              このタブで再開
            </Button>
          ) : (
            s.cmux && (
              <Button tone="accent" disabled={busy} onClick={() => run(() => focusSession(s.cmux!), "cmux のタブを開きました")}>
                {s.live ? "cmux で開く" : "cmux で再開"}
              </Button>
            )
          )}
          {s.live && s.cmux && (
            <Button
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const outcome = await hibernateSession(s);
                  setMessage({
                    tone: "ok",
                    text:
                      outcome === "cmux"
                        ? "cmux で休止しました。タブを開くと自動で再開します"
                        : "休止しました（プロセスを止めてメモリを空けました）。「このタブで再開」で戻せます",
                  });
                  onChanged();
                }, "")
              }
              title="会話を保持したままプロセスを止め、メモリを空けます（idle のときのみ）"
            >
              休止
            </Button>
          )}
          {s.live &&
            (confirmKill ? (
              <>
                <span className="text-xs text-danger">本当に終了しますか？</span>
                <Button tone="danger" disabled={busy} onClick={() => run(() => terminateSession(s.live!.pid), "終了しました", true)}>
                  終了する
                </Button>
                <Button onClick={() => setConfirmKill(false)}>やめる</Button>
              </>
            ) : (
              <Button tone="danger" disabled={busy} onClick={() => setConfirmKill(true)}>
                終了
              </Button>
            ))}
          {s.kind === "main" && (
            <Button disabled={busy} onClick={copyResume} title={resumeCommand(s)}>
              再開コマンドをコピー
            </Button>
          )}
          {s.parentSessionId && <Button onClick={() => onOpenParent(s.parentSessionId!)}>親セッションを開く</Button>}
        </div>

        {message && (
          <p className={`text-xs ${message.tone === "ok" ? "text-success" : "text-danger"}`}>{message.text}</p>
        )}
      </div>

      <ConversationView key={s.path} path={s.path} focusUuid={focusUuid} />
    </section>
  );
}
