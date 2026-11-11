//! ~/.claude/projects 以下の全セッション (通常 + サブエージェント) を集める。

use crate::live::CmuxLocation;
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SessionKind {
    Main,
    Subagent,
}

/// 実行中のときだけ付く情報
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct LiveInfo {
    pub pid: u32,
    pub status: String,
    pub memory_kb: Option<u64>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    /// jsonl のパス (一意のキー)
    pub path: String,
    /// セッション ID (サブエージェントは agent-xxx)
    pub id: String,
    pub kind: SessionKind,
    pub parent_session_id: Option<String>,
    pub agent_type: Option<String>,
    /// projects 直下のディレクトリ名
    pub project_dir: String,
    pub cwd: Option<String>,
    pub title: Option<String>,
    pub last_prompt: Option<String>,
    /// 最初の記録の時刻 (ISO 8601)
    pub created_at: Option<String>,
    /// ファイルの更新時刻 (ミリ秒)
    pub updated_at: u64,
    pub live: Option<LiveInfo>,
    /// cmux 上の場所 (実行中、または cmux が休止・復元用に覚えているとき)
    pub cmux: Option<CmuxLocation>,
    /// アプリが休止させた (SIGTERM で止めた) セッションか。同じタブで再開できる
    pub suspended: bool,
}

/// (サイズ, 更新時刻ミリ秒)
type Signature = (u64, u64);

/// ファイルの Signature が同じなら前回の結果を使い回すためのキャッシュ
#[derive(Default)]
pub struct HistoryCache(Mutex<std::collections::HashMap<PathBuf, (Signature, SessionInfo)>>);

/// 走査対象の 1 ファイル
struct Candidate {
    path: PathBuf,
    project_dir: String,
    kind: SessionKind,
    parent_session_id: Option<String>,
}

pub fn scan_projects(projects_dir: &Path, cache: &HistoryCache) -> Vec<SessionInfo> {
    use rayon::prelude::*;

    let candidates = list_candidates(projects_dir);
    let mut cached = cache.0.lock().unwrap();
    let (fresh, stale): (Vec<_>, Vec<_>) = candidates.into_iter().partition(|c| {
        let sig = signature(&c.path);
        sig.is_some() && cached.get(&c.path).is_some_and(|(s, _)| Some(*s) == sig)
    });
    let mut rows: Vec<SessionInfo> = fresh.iter().map(|c| cached[&c.path].1.clone()).collect();

    // 変わったファイルだけ並列に読み直す (ロックは保持したまま。読み込み中に他から触られない)
    let read: Vec<_> = stale
        .par_iter()
        .filter_map(|c| Some((c.path.clone(), signature(&c.path)?, read_session(c))))
        .collect();
    for (path, sig, info) in read {
        cached.insert(path, (sig, info.clone()));
        rows.push(info);
    }
    rows
}

/// (サイズ, 更新時刻ミリ秒)
fn signature(path: &Path) -> Option<Signature> {
    let meta = std::fs::metadata(path).ok()?;
    let mtime = meta.modified().ok()?.duration_since(std::time::UNIX_EPOCH).ok()?;
    Some((meta.len(), mtime.as_millis() as u64))
}

fn list_candidates(projects_dir: &Path) -> Vec<Candidate> {
    let mut out = Vec::new();
    for project in read_dir_paths(projects_dir).into_iter().filter(|p| p.is_dir()) {
        let project_dir = file_name(&project);
        for entry in read_dir_paths(&project) {
            if entry.is_file() && entry.extension().is_some_and(|e| e == "jsonl") {
                out.push(Candidate {
                    path: entry,
                    project_dir: project_dir.clone(),
                    kind: SessionKind::Main,
                    parent_session_id: None,
                });
            } else if entry.is_dir() {
                let parent = file_name(&entry);
                for agent in walk_files(&entry.join("subagents")) {
                    let name = file_name(&agent);
                    if name.starts_with("agent-") && name.ends_with(".jsonl") {
                        out.push(Candidate {
                            path: agent,
                            project_dir: project_dir.clone(),
                            kind: SessionKind::Subagent,
                            parent_session_id: Some(parent.clone()),
                        });
                    }
                }
            }
        }
    }
    out
}

fn read_session(c: &Candidate) -> SessionInfo {
    let summary = crate::transcript::summarize_file(&c.path, &c.project_dir);
    let meta = (c.kind == SessionKind::Subagent).then(|| read_agent_meta(&c.path)).flatten();
    let description = meta.as_ref().and_then(|m| m["description"].as_str().map(str::to_string));
    SessionInfo {
        path: c.path.to_string_lossy().into_owned(),
        id: c.path.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default(),
        kind: c.kind,
        parent_session_id: c.parent_session_id.clone(),
        agent_type: meta.as_ref().and_then(|m| m["agentType"].as_str().map(str::to_string)),
        project_dir: c.project_dir.clone(),
        cwd: summary.cwd().map(str::to_string),
        title: description.or_else(|| summary.title().map(str::to_string)),
        last_prompt: summary.last_prompt().map(str::to_string),
        created_at: summary.first_timestamp().map(str::to_string),
        updated_at: signature(&c.path).map(|(_, m)| m).unwrap_or(0),
        live: None,
        cmux: None,
        suspended: false,
    }
}

/// agent-xxx.jsonl に対応する agent-xxx.meta.json
fn read_agent_meta(jsonl: &Path) -> Option<serde_json::Value> {
    let text = std::fs::read_to_string(jsonl.with_extension("meta.json")).ok()?;
    serde_json::from_str(&text).ok()
}

fn read_dir_paths(dir: &Path) -> Vec<PathBuf> {
    std::fs::read_dir(dir)
        .map(|it| it.flatten().map(|e| e.path()).collect())
        .unwrap_or_default()
}

fn walk_files(dir: &Path) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for p in read_dir_paths(dir) {
        if p.is_dir() {
            out.extend(walk_files(&p));
        } else {
            out.push(p);
        }
    }
    out
}

fn file_name(p: &Path) -> String {
    p.file_name().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use tempfile::TempDir;

    fn write(path: &Path, body: &str) {
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, body).unwrap();
    }

    const MAIN: &str = concat!(
        r#"{"type":"user","cwd":"/Users/me/a","timestamp":"2026-11-01T00:00:00.000Z","message":{"content":"こんにちは"}}"#,
        "\n",
        r#"{"type":"ai-title","aiTitle":"メインの会話"}"#,
        "\n"
    );

    fn by_id<'a>(rows: &'a [SessionInfo], id: &str) -> &'a SessionInfo {
        rows.iter().find(|r| r.id == id).unwrap_or_else(|| panic!("{id} がない"))
    }

    #[test]
    fn main_session_is_read_from_project_directory() {
        let dir = TempDir::new().unwrap();
        write(&dir.path().join("-Users-me-a/s1.jsonl"), MAIN);

        let rows = scan_projects(dir.path(), &HistoryCache::default());

        let s = by_id(&rows, "s1");
        assert_eq!(s.kind, SessionKind::Main);
        assert_eq!(s.project_dir, "-Users-me-a");
        assert_eq!(s.title.as_deref(), Some("メインの会話"));
        assert_eq!(s.cwd.as_deref(), Some("/Users/me/a"));
        assert_eq!(s.created_at.as_deref(), Some("2026-11-01T00:00:00.000Z"));
        assert!(s.updated_at > 0);
    }

    #[test]
    fn subagents_are_read_with_parent_and_meta() {
        let dir = TempDir::new().unwrap();
        let p = dir.path().join("-Users-me-a");
        write(&p.join("s1.jsonl"), MAIN);
        write(&p.join("s1/subagents/agent-abc.jsonl"), MAIN);
        write(
            &p.join("s1/subagents/agent-abc.meta.json"),
            r#"{"agentType":"Explore","description":"コードを調査"}"#,
        );
        write(&p.join("s1/subagents/workflows/wf_1/agent-def.jsonl"), MAIN);
        write(&p.join("s1/subagents/workflows/wf_1/journal.jsonl"), MAIN);

        let rows = scan_projects(dir.path(), &HistoryCache::default());

        assert_eq!(rows.len(), 3);
        let a = by_id(&rows, "agent-abc");
        assert_eq!(a.kind, SessionKind::Subagent);
        assert_eq!(a.parent_session_id.as_deref(), Some("s1"));
        assert_eq!(a.agent_type.as_deref(), Some("Explore"));
        assert_eq!(a.title.as_deref(), Some("コードを調査"));
        let d = by_id(&rows, "agent-def");
        assert_eq!(d.parent_session_id.as_deref(), Some("s1"));
        assert_eq!(d.title.as_deref(), Some("メインの会話"));
    }

    #[test]
    fn cache_is_refreshed_when_file_changes() {
        let dir = TempDir::new().unwrap();
        let file = dir.path().join("-Users-me-a/s1.jsonl");
        write(&file, MAIN);
        let cache = HistoryCache::default();
        scan_projects(dir.path(), &cache);

        write(&file, &format!("{MAIN}{}\n", r#"{"type":"custom-title","customTitle":"改名後"}"#));
        let rows = scan_projects(dir.path(), &cache);

        assert_eq!(by_id(&rows, "s1").title.as_deref(), Some("改名後"));
    }
}

/// 実データでの所要時間を測る: cargo test --release --lib real_history -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn real_history_timing() {
    let dir = PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
    let cache = HistoryCache::default();
    for label in ["cold", "warm"] {
        let started = std::time::Instant::now();
        let rows = scan_projects(&dir, &cache);
        let subs = rows.iter().filter(|r| r.kind == SessionKind::Subagent).count();
        println!("{label}: {} rows ({subs} subagents) in {:?}", rows.len(), started.elapsed());
    }
}

/// 画面確認用に実データを書き出す: MOCK_OUT=<dir> cargo test --lib dump_mock -- --ignored
#[cfg(test)]
#[test]
#[ignore]
fn dump_mock_fixtures() {
    let out = PathBuf::from(std::env::var("MOCK_OUT").unwrap());
    let dir = PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
    let rows = scan_projects(&dir, &HistoryCache::default());
    std::fs::write(out.join("sessions.json"), serde_json::to_string(&rows).unwrap()).unwrap();
}
