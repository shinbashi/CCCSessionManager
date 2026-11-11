mod history;
mod live;
mod messages;
mod process;
mod suspended;
mod transcript;

use history::{HistoryCache, SessionInfo};
use std::path::PathBuf;
use std::process::Command;
use std::sync::Arc;

/// Finder から起動すると PATH に cmux が無いため、アプリ同梱の CLI を優先する
const CMUX_BUNDLED: &str = "/Applications/cmux.app/Contents/Resources/bin/cmux";

fn cmux_command() -> Command {
    let bin = if std::path::Path::new(CMUX_BUNDLED).exists() { CMUX_BUNDLED } else { "cmux" };
    Command::new(bin)
}

/// コマンドを実行し、失敗したら stderr をエラーとして返す
fn run_checked(mut cmd: Command) -> Result<(), String> {
    let out = cmd.output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(())
    } else {
        // cmux は失敗理由を stdout に出すこともあるので両方返す
        let msg = format!(
            "{} {}",
            String::from_utf8_lossy(&out.stderr).trim(),
            String::from_utf8_lossy(&out.stdout).trim()
        );
        Err(msg.trim().to_string())
    }
}

fn run_stdout(mut cmd: Command) -> String {
    cmd.output()
        .map(|o| String::from_utf8_lossy(&o.stdout).into_owned())
        .unwrap_or_default()
}

/// アプリが休止させたセッションの記録 (~/Library/Application Support/<identifier>/suspended.json)
fn suspended_store_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    PathBuf::from(home).join("Library/Application Support/io.github.shinbashi.cccsessionmanager/suspended.json")
}

fn claude_dir() -> Result<PathBuf, String> {
    std::env::var("HOME")
        .map(|h| PathBuf::from(h).join(".claude"))
        .map_err(|_| "HOME が取得できません".to_string())
}

fn ps(args: &[&str]) -> String {
    let mut cmd = Command::new("/bin/ps");
    cmd.args(args);
    run_stdout(cmd)
}

/// 過去分も含む全セッション (通常 + サブエージェント)。実行中のものには PID などを付ける
#[tauri::command]
async fn list_sessions(
    cache: tauri::State<'_, Arc<HistoryCache>>,
    suspended_store: tauri::State<'_, Arc<suspended::SuspendedStore>>,
) -> Result<Vec<SessionInfo>, String> {
    let cache = Arc::clone(&cache);
    let suspended_store = Arc::clone(&suspended_store);
    tauri::async_runtime::spawn_blocking(move || {
        let claude_dir = claude_dir()?;
        let alive = process::parse_claude_pids(&ps(&["-Ao", "pid=,args="]));

        // cmux がタブ内のプロセスに渡す CMUX_SURFACE_ID などの環境変数からタブを特定する
        let cmux_by_pid = if alive.is_empty() {
            Default::default()
        } else {
            let pids = alive.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
            process::parse_cmux_env(&ps(&["eww", "-o", "pid=,command=", "-p", &pids]))
        };
        let memory = process::tree_rss_kb(&ps(&["-Ao", "pid=,ppid=,rss="]), &alive);
        let mut records = cmux_command();
        records.args(["sessions", "list", "--agent", "claude", "--all", "--json"]);
        let cmux_records = live::parse_cmux_records(&run_stdout(records));

        let mut rows = history::scan_projects(&claude_dir.join("projects"), &cache);
        let live_files = live::read_live_files(&claude_dir, &alive);
        live::attach_live(&mut rows, &live_files, &cmux_by_pid, &memory, &cmux_records, &suspended_store.load());
        Ok(rows)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 画面から渡されたパスが ~/.claude/projects 以下の会話記録であることを確かめる
fn transcript_path(path: &str) -> Result<PathBuf, String> {
    let projects = claude_dir()?.join("projects").canonicalize().map_err(|e| e.to_string())?;
    let target = PathBuf::from(path).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&projects) {
        return Err(format!("{path} は ~/.claude/projects の外にあります"));
    }
    Ok(target)
}

/// 会話ビューア用に、1 セッションの全ブロックを読む
#[tauri::command]
async fn load_transcript(path: String) -> Result<Vec<messages::Block>, String> {
    tauri::async_runtime::spawn_blocking(move || Ok(messages::load_blocks(&transcript_path(&path)?)))
        .await
        .map_err(|e| e.to_string())?
}

/// 省略して表示しているブロックの全文を読む
#[tauri::command]
async fn load_full_block(path: String, seq: usize, uuid: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        messages::load_full_text(&transcript_path(&path)?, seq, uuid.as_deref())
            .ok_or_else(|| "会話記録が変わったため、全文を読み込めませんでした。会話を開き直してください".to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 全セッションを全文検索する
#[tauri::command]
async fn search_messages(
    cache: tauri::State<'_, Arc<HistoryCache>>,
    query: String,
    kinds: Vec<messages::BlockKind>,
    limit: usize,
) -> Result<messages::SearchResult, String> {
    let cache = Arc::clone(&cache);
    tauri::async_runtime::spawn_blocking(move || {
        let paths: Vec<PathBuf> = history::scan_projects(&claude_dir()?.join("projects"), &cache)
            .into_iter()
            .map(|s| PathBuf::from(s.path))
            .collect();
        let kinds = kinds.into_iter().collect();
        Ok(messages::search_files(&paths, &query, &kinds, limit))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// セッションが動いている cmux のタブを表示して、cmux を前面に出す
#[tauri::command]
async fn focus_session(workspace_id: String, surface_id: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut select = cmux_command();
        select.args(["select-workspace", "--workspace", &workspace_id]);
        run_checked(select)?;

        let mut focus = cmux_command();
        focus.args(["focus-panel", "--panel", &surface_id, "--workspace", &workspace_id]);
        run_checked(focus)?;

        let mut open = Command::new("/usr/bin/open");
        open.args(["-a", "cmux"]);
        run_checked(open)
    })
    .await
    .map_err(|e| e.to_string())?
}

/// 休止の結果
#[derive(Debug, serde::Serialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum HibernateOutcome {
    /// cmux の Agent Hibernation で休止した (タブを開くと cmux が自動で再開する)
    Cmux,
    /// cmux が拒否したので、アプリが SIGTERM で止めた (再開ボタンで同じタブに戻す)
    Suspended,
}

/// まず cmux の休止を試し、拒否されたら idle のときだけアプリ側で止める
fn hibernate_or_suspend(
    store: &suspended::SuspendedStore,
    loc: &live::CmuxLocation,
    pid: u32,
    session_id: &str,
) -> Result<HibernateOutcome, String> {
    let mut cmd = cmux_command();
    cmd.args(["agent-hibernation", "hibernate", &loc.surface_id, "--workspace", &loc.workspace_id]);
    let cmux_error = match run_checked(cmd) {
        Ok(()) => return Ok(HibernateOutcome::Cmux),
        Err(e) => e,
    };
    // 作業中のセッションは止めない (止める直前の状態を読み直す)
    let status = std::fs::read_to_string(claude_dir()?.join(format!("sessions/{pid}.json")))
        .ok()
        .and_then(|s| live::parse_session_file(&s))
        .filter(|f| f.session_id == session_id)
        .map(|f| f.status);
    if status.as_deref() != Some("idle") {
        return Err(format!("cmux が休止できず（{cmux_error}）、セッションが idle ではないため止めませんでした"));
    }
    store.insert(session_id, loc.clone())?;
    if let Err(e) = process::terminate_claude(pid) {
        store.remove(session_id)?;
        return Err(e);
    }
    Ok(HibernateOutcome::Suspended)
}

/// アプリが止めたセッションを、同じ cmux タブで `claude --resume` して再開する
fn resume_in_tab(
    store: &suspended::SuspendedStore,
    loc: &live::CmuxLocation,
    session_id: &str,
    cwd: Option<&str>,
) -> Result<(), String> {
    // そのタブで別の claude が動いていると、その claude への指示として送られてしまう
    let alive = process::parse_claude_pids(&ps(&["-Ao", "pid=,args="]));
    if !alive.is_empty() {
        let pids = alive.iter().map(u32::to_string).collect::<Vec<_>>().join(",");
        let busy = process::parse_cmux_env(&ps(&["eww", "-o", "pid=,command=", "-p", &pids]))
            .values()
            .any(|l| l.surface_id == loc.surface_id);
        if busy {
            return Err("このタブでは別の Claude Code が動いているため、再開できません".into());
        }
    }
    let mut send = cmux_command();
    // cmux send は \n を Enter として送る
    let text = format!("{}\\n", suspended::resume_command(cwd, session_id));
    send.args(["send", "--workspace", &loc.workspace_id, "--surface", &loc.surface_id, "--", &text]);
    run_checked(send)?;
    store.remove(session_id)
}

#[tauri::command]
async fn hibernate_session(
    store: tauri::State<'_, Arc<suspended::SuspendedStore>>,
    workspace_id: String,
    surface_id: String,
    pid: u32,
    session_id: String,
) -> Result<HibernateOutcome, String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let loc = live::CmuxLocation { surface_id, workspace_id };
        hibernate_or_suspend(&store, &loc, pid, &session_id)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn resume_session(
    store: tauri::State<'_, Arc<suspended::SuspendedStore>>,
    workspace_id: String,
    surface_id: String,
    session_id: String,
    cwd: Option<String>,
) -> Result<(), String> {
    let store = Arc::clone(&store);
    tauri::async_runtime::spawn_blocking(move || {
        let loc = live::CmuxLocation { surface_id, workspace_id };
        resume_in_tab(&store, &loc, &session_id, cwd.as_deref())
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Claude Code のプロセスに SIGTERM を送って終了させる (タブとシェルは残る)
#[tauri::command]
async fn terminate_session(pid: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || process::terminate_claude(pid))
        .await
        .map_err(|e| e.to_string())?
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Arc::new(HistoryCache::default()))
        .manage(Arc::new(suspended::SuspendedStore::new(suspended_store_path())))
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![
            list_sessions,
            load_transcript,
            load_full_block,
            search_messages,
            focus_session,
            hibernate_session,
            resume_session,
            terminate_session
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}

/// 実機での休止→再開の確認 (本物の cmux タブを使う):
/// E2E_WS=.. E2E_SURF=.. E2E_PID=.. E2E_SID=.. E2E_CWD=.. E2E_STORE=.. cargo test --lib e2e_hibernate -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn e2e_hibernate_then_resume() {
    let env = |k: &str| std::env::var(k).unwrap();
    let store = suspended::SuspendedStore::new(PathBuf::from(env("E2E_STORE")));
    let loc = live::CmuxLocation { surface_id: env("E2E_SURF"), workspace_id: env("E2E_WS") };
    let pid: u32 = env("E2E_PID").parse().unwrap();
    let sid = env("E2E_SID");

    let outcome = hibernate_or_suspend(&store, &loc, pid, &sid).unwrap();
    println!("hibernate outcome: {outcome:?}");
    std::thread::sleep(std::time::Duration::from_secs(2));
    assert!(!process::parse_claude_pids(&ps(&["-Ao", "pid=,args="])).contains(&pid), "休止後も claude が残っている");
    if outcome == HibernateOutcome::Suspended {
        assert!(store.load().contains_key(&sid), "休止の記録がない");
        resume_in_tab(&store, &loc, &sid, Some(&env("E2E_CWD"))).unwrap();
        assert!(!store.load().contains_key(&sid), "再開後も記録が残っている");
        println!("resume sent");
    }
}
