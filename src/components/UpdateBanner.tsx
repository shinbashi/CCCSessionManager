import { listen } from "@tauri-apps/api/event";
import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import { Button } from "./ui";

/** 手動で確認したときだけ出す結果 (起動時の自動確認では、更新が無ければ何も出さない) */
type Notice = { tone: "info" | "error"; text: string } | null;

/**
 * 起動時と、アプリメニューの「Check for Updates…」で GitHub Releases の latest.json を確認し、
 * 新しいバージョンがあれば知らせる。「更新して再起動」でダウンロード → 署名を検証してインストール → 再起動する
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const run = async (manual: boolean) => {
      if (manual) setNotice({ tone: "info", text: "アップデートを確認中…" });
      try {
        const found = await check();
        setUpdate(found);
        if (manual && !found) {
          setNotice({ tone: "info", text: "最新バージョンを使っています" });
          clearTimeout(timer);
          timer = setTimeout(() => setNotice(null), 4000);
        } else {
          setNotice(null);
        }
      } catch (e) {
        // 起動時はオフラインなどで確認できなくても、アプリの利用は妨げない
        console.warn("アップデートの確認に失敗しました", e);
        if (manual) setNotice({ tone: "error", text: `アップデートを確認できませんでした: ${e}` });
      }
    };
    run(false);
    const unlisten = listen("check-updates", () => run(true));
    return () => {
      clearTimeout(timer);
      unlisten.then((f) => f());
    };
  }, []);

  if (!update) {
    if (!notice) return null;
    return (
      <div
        className={`flex items-center gap-3 border-b px-4 py-2 text-xs ${
          notice.tone === "error" ? "border-danger/40 bg-danger/10 text-danger" : "border-line bg-card text-muted"
        }`}
      >
        <span>{notice.text}</span>
        <Button className="ml-auto" onClick={() => setNotice(null)}>
          閉じる
        </Button>
      </div>
    );
  }

  const install = async () => {
    setError(null);
    let total = 0;
    let done = 0;
    try {
      await update.downloadAndInstall((event) => {
        if (event.event === "Started") total = event.data.contentLength ?? 0;
        if (event.event === "Progress") {
          done += event.data.chunkLength;
          setProgress(total ? `ダウンロード中… ${Math.round((done / total) * 100)}%` : "ダウンロード中…");
        }
        if (event.event === "Finished") setProgress("インストール中…");
      });
      await relaunch();
    } catch (e) {
      setProgress(null);
      setError(String(e));
    }
  };

  return (
    <div className="flex items-center gap-3 border-b border-accent/40 bg-accent/10 px-4 py-2 text-xs">
      <span className="text-accent">
        新しいバージョン v{update.version} があります（現在 v{update.currentVersion}）
      </span>
      {progress ? (
        <span className="text-muted">{progress}</span>
      ) : (
        <>
          <Button tone="accent" onClick={install}>
            更新して再起動
          </Button>
          <Button onClick={() => setUpdate(null)}>後で</Button>
        </>
      )}
      {error && <span className="text-danger">更新に失敗しました: {error}</span>}
    </div>
  );
}
