//! アプリが休止させた (SIGTERM で止めた) セッションと、その cmux タブの記録。
//! cmux の休止が使えないときに、同じタブで再開できるようにするため。

use crate::live::CmuxLocation;
use std::collections::HashMap;
use std::path::{Path, PathBuf};

/// セッションID → 止めたときのタブ を JSON ファイルに保存する
pub struct SuspendedStore {
    path: PathBuf,
}

impl SuspendedStore {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    pub fn load(&self) -> HashMap<String, CmuxLocation> {
        std::fs::read_to_string(&self.path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn insert(&self, session_id: &str, loc: CmuxLocation) -> Result<(), String> {
        let mut map = self.load();
        map.insert(session_id.to_string(), loc);
        self.save(&map)
    }

    pub fn remove(&self, session_id: &str) -> Result<(), String> {
        let mut map = self.load();
        if map.remove(session_id).is_some() {
            self.save(&map)?;
        }
        Ok(())
    }

    fn save(&self, map: &HashMap<String, CmuxLocation>) -> Result<(), String> {
        if let Some(dir) = Path::new(&self.path).parent() {
            std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
        }
        let json = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
        std::fs::write(&self.path, json).map_err(|e| e.to_string())
    }
}

/// 同じタブでセッションを再開するために送るコマンド (シェル向けにクォートする)
pub fn resume_command(cwd: Option<&str>, session_id: &str) -> String {
    match cwd {
        Some(dir) => format!("cd '{}' && claude --resume {session_id}", dir.replace('\'', r"'\''")),
        None => format!("claude --resume {session_id}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn loc(s: &str) -> CmuxLocation {
        CmuxLocation { surface_id: s.into(), workspace_id: "W".into() }
    }

    #[test]
    fn insert_load_remove_roundtrip() {
        let dir = tempfile::TempDir::new().unwrap();
        let store = SuspendedStore::new(dir.path().join("sub/suspended.json"));
        assert!(store.load().is_empty());

        store.insert("s1", loc("A")).unwrap();
        store.insert("s2", loc("B")).unwrap();
        // 別インスタンスから読んでも残っている
        let again = SuspendedStore::new(dir.path().join("sub/suspended.json"));
        assert_eq!(again.load().get("s1"), Some(&loc("A")));

        again.remove("s1").unwrap();
        let map = store.load();
        assert_eq!(map.len(), 1);
        assert_eq!(map.get("s2"), Some(&loc("B")));
    }

    #[test]
    fn resume_command_quotes_cwd() {
        assert_eq!(
            resume_command(Some("/Users/me/it's dir"), "abc-123"),
            r"cd '/Users/me/it'\''s dir' && claude --resume abc-123"
        );
        assert_eq!(resume_command(None, "abc"), "claude --resume abc");
    }
}
