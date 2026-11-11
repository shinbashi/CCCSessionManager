//! 実行中の Claude Code セッションの情報を、全セッション一覧に結びつける。
//! - ~/.claude/sessions/<pid>.json : PID とセッションの対応 (Claude Code が書く)
//! - PID → cmux タブ : process::parse_cmux_env (cmux がタブ内プロセスに渡す環境変数)
//! - 実行中でないセッションの cmux タブ : `cmux sessions list --json` (休止中などの記録)

use crate::history::{LiveInfo, SessionInfo, SessionKind};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

/// ~/.claude/sessions/<pid>.json 1 件分
#[derive(Debug, Clone, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub pid: u32,
    pub session_id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub status: String,
    /// ミリ秒の UNIX 時刻
    #[serde(default)]
    pub updated_at: u64,
}

pub fn parse_session_file(json: &str) -> Option<SessionFile> {
    serde_json::from_str(json).ok()
}

/// cmux 上でセッションが動いている (または休止している) 場所
#[derive(Debug, Clone, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CmuxLocation {
    pub surface_id: String,
    pub workspace_id: String,
}

/// 生きている PID の sessions/<pid>.json を セッションID → 情報 の表にする
/// (sessions/ には終了済みセッションのファイルも残っている)
pub fn read_live_files(claude_dir: &Path, alive_pids: &HashSet<u32>) -> HashMap<String, SessionFile> {
    let Ok(entries) = fs::read_dir(claude_dir.join("sessions")) else {
        return HashMap::new();
    };
    entries
        .flatten()
        .filter(|e| e.path().extension().is_some_and(|x| x == "json"))
        .filter_map(|e| parse_session_file(&fs::read_to_string(e.path()).ok()?))
        .filter(|f| alive_pids.contains(&f.pid))
        .map(|f| (f.session_id.clone(), f))
        .collect()
}

/// `cmux sessions list --agent claude --all --json` を セッションID → 場所 の表にする
pub fn parse_cmux_records(json: &str) -> HashMap<String, CmuxLocation> {
    #[derive(Deserialize)]
    struct Output {
        sessions: Vec<Record>,
    }
    #[derive(Deserialize)]
    struct Record {
        agent: Option<String>,
        session_id: Option<String>,
        surface_id: Option<String>,
        workspace_id: Option<String>,
    }
    let Ok(output) = serde_json::from_str::<Output>(json) else {
        return HashMap::new();
    };
    output
        .sessions
        .into_iter()
        .filter(|r| r.agent.as_deref() == Some("claude"))
        .filter_map(|r| {
            Some((r.session_id?, CmuxLocation { surface_id: r.surface_id?, workspace_id: r.workspace_id? }))
        })
        .collect()
}

/// 全セッションに実行中の情報と cmux の場所を付ける
pub fn attach_live(
    rows: &mut [SessionInfo],
    live: &HashMap<String, SessionFile>,
    cmux_by_pid: &HashMap<u32, CmuxLocation>,
    memory_kb: &HashMap<u32, u64>,
    cmux_records: &HashMap<String, CmuxLocation>,
    suspended: &HashMap<String, CmuxLocation>,
) {
    for row in rows.iter_mut().filter(|r| r.kind == SessionKind::Main) {
        if let Some(f) = live.get(&row.id) {
            row.live = Some(LiveInfo {
                pid: f.pid,
                status: f.status.clone(),
                memory_kb: memory_kb.get(&f.pid).copied(),
            });
            row.cmux = cmux_by_pid.get(&f.pid).cloned();
        } else if let Some(loc) = suspended.get(&row.id) {
            row.cmux = Some(loc.clone());
            row.suspended = true;
        } else {
            row.cmux = cmux_records.get(&row.id).cloned();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::TempDir;

    #[test]
    fn parses_session_file() {
        let json = r#"{"pid":13754,"sessionId":"session-1","cwd":"/Users/me","status":"idle","updatedAt":1794315965432,"kind":"interactive"}"#;
        assert_eq!(
            parse_session_file(json),
            Some(SessionFile {
                pid: 13754,
                session_id: "session-1".into(),
                cwd: "/Users/me".into(),
                status: "idle".into(),
                updated_at: 1794315965432,
            })
        );
    }

    #[test]
    fn session_file_without_session_id_is_rejected() {
        assert_eq!(parse_session_file(r#"{"pid":1,"cwd":"/"}"#), None);
    }

    #[test]
    fn only_alive_session_files_are_read() {
        let dir = TempDir::new().unwrap();
        fs::create_dir_all(dir.path().join("sessions")).unwrap();
        for (pid, sid) in [(10, "alive"), (20, "dead")] {
            fs::write(
                dir.path().join(format!("sessions/{pid}.json")),
                format!(r#"{{"pid":{pid},"sessionId":"{sid}","status":"idle"}}"#),
            )
            .unwrap();
        }

        let live = read_live_files(dir.path(), &HashSet::from([10]));

        assert_eq!(live.keys().collect::<Vec<_>>(), ["alive"]);
    }

    #[test]
    fn parses_cmux_records_of_claude_sessions() {
        let json = r#"{"sessions":[
            {"agent":"claude","session_id":"s1","surface_id":"S1","workspace_id":"W1"},
            {"agent":"codex","session_id":"s2","surface_id":"S2","workspace_id":"W2"},
            {"agent":"claude","session_id":"s3","surface_id":null,"workspace_id":null}
        ]}"#;
        let map = parse_cmux_records(json);
        assert_eq!(map.len(), 1);
        assert_eq!(map["s1"], CmuxLocation { surface_id: "S1".into(), workspace_id: "W1".into() });
        assert!(parse_cmux_records("not json").is_empty());
    }

    fn row(id: &str, kind: SessionKind) -> SessionInfo {
        SessionInfo {
            path: format!("/p/{id}.jsonl"),
            id: id.into(),
            kind,
            parent_session_id: None,
            agent_type: None,
            project_dir: "-p".into(),
            cwd: None,
            title: None,
            last_prompt: None,
            created_at: None,
            updated_at: 0,
            live: None,
            cmux: None,
            suspended: false,
        }
    }

    #[test]
    fn live_and_cmux_info_are_attached() {
        let loc = |s: &str| CmuxLocation { surface_id: s.into(), workspace_id: "W".into() };
        let mut rows = vec![
            row("running", SessionKind::Main),
            row("hibernated", SessionKind::Main),
            row("closed", SessionKind::Main),
        ];
        let live = HashMap::from([(
            "running".to_string(),
            SessionFile { pid: 10, session_id: "running".into(), cwd: String::new(), status: "busy".into(), updated_at: 0 },
        )]);
        let records = HashMap::from([("hibernated".to_string(), loc("OLD"))]);

        attach_live(&mut rows, &live, &HashMap::from([(10, loc("LIVE"))]), &HashMap::from([(10, 2048)]), &records, &HashMap::new());

        assert_eq!(rows[0].live, Some(LiveInfo { pid: 10, status: "busy".into(), memory_kb: Some(2048) }));
        assert_eq!(rows[0].cmux, Some(loc("LIVE")));
        assert_eq!(rows[1].live, None);
        assert_eq!(rows[1].cmux, Some(loc("OLD")));
        assert_eq!((&rows[2].live, &rows[2].cmux), (&None, &None));
    }

    #[test]
    fn suspended_sessions_get_their_tab_unless_running_again() {
        let loc = |s: &str| CmuxLocation { surface_id: s.into(), workspace_id: "W".into() };
        let mut rows = vec![row("stopped", SessionKind::Main), row("resumed", SessionKind::Main)];
        let live = HashMap::from([(
            "resumed".to_string(),
            SessionFile { pid: 10, session_id: "resumed".into(), cwd: String::new(), status: "idle".into(), updated_at: 0 },
        )]);
        let suspended = HashMap::from([("stopped".to_string(), loc("TAB")), ("resumed".to_string(), loc("TAB2"))]);

        attach_live(&mut rows, &live, &HashMap::from([(10, loc("LIVE"))]), &HashMap::new(), &HashMap::new(), &suspended);

        assert_eq!((rows[0].suspended, rows[0].cmux.clone()), (true, Some(loc("TAB"))));
        // 再開済み (実行中) なら休止扱いにしない
        assert_eq!((rows[1].suspended, rows[1].cmux.clone()), (false, Some(loc("LIVE"))));
    }
}
