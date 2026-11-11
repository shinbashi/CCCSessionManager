import { relaunch } from "@tauri-apps/plugin-process";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { useEffect, useState } from "react";
import { Button } from "./ui";

/**
 * 起動時に GitHub Releases の latest.json を見て、新しいバージョンがあれば知らせる。
 * 「更新して再起動」でダウンロード → 署名を検証してインストール → 再起動する
 */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    // オフラインなどで確認できなくても、アプリの利用は妨げない
    check()
      .then(setUpdate)
      .catch((e) => console.warn("アップデートの確認に失敗しました", e));
  }, []);

  if (!update || dismissed) return null;

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
          <Button onClick={() => setDismissed(true)}>後で</Button>
        </>
      )}
      {error && <span className="text-danger">更新に失敗しました: {error}</span>}
    </div>
  );
}
