//! 会話記録の 1 行を、表示・検索用のブロック (5 種類) に分解する。

use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BlockKind {
    /// ユーザーの発言
    User,
    /// Claude の文章
    Assistant,
    /// 思考プロセス
    Thinking,
    /// ツールの呼び出し
    ToolUse,
    /// ツールの実行結果
    ToolResult,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub kind: BlockKind,
    pub text: String,
    /// tool_use のツール名
    pub tool_name: Option<String>,
    pub timestamp: Option<String>,
    pub uuid: Option<String>,
    /// 表示用に text を切り詰めたか
    pub truncated: bool,
}

/// 会話ビューア用に、セッションの全ブロックを読む。長い text は切り詰める
/// (ツールの入出力は 2,000 文字、それ以外は 20,000 文字まで)
pub fn load_blocks(path: &std::path::Path) -> Vec<Block> {
    use std::io::{BufRead, BufReader};
    let Ok(file) = std::fs::File::open(path) else {
        return Vec::new();
    };
    BufReader::new(file)
        .lines()
        .map_while(Result::ok)
        .flat_map(|line| parse_line(&line))
        .map(|mut b| {
            let max = match b.kind {
                BlockKind::ToolUse | BlockKind::ToolResult => 2_000,
                _ => 20_000,
            };
            if let Some((cut, _)) = b.text.char_indices().nth(max) {
                b.text.truncate(cut);
                b.truncated = true;
            }
            b
        })
        .collect()
}

pub fn parse_line(line: &str) -> Vec<Block> {
    let Ok(entry) = serde_json::from_str::<Value>(line) else {
        return Vec::new();
    };
    let block = |kind, text: String, tool_name: Option<String>| Block {
        kind,
        text,
        tool_name,
        timestamp: entry["timestamp"].as_str().map(str::to_string),
        uuid: entry["uuid"].as_str().map(str::to_string),
        truncated: false,
    };
    let content = &entry["message"]["content"];
    match entry["type"].as_str() {
        Some("user") if entry["isMeta"] != true => match content {
            Value::String(s) => vec![block(BlockKind::User, s.clone(), None)],
            Value::Array(items) => items
                .iter()
                .filter_map(|i| match i["type"].as_str()? {
                    "text" => Some(block(BlockKind::User, i["text"].as_str()?.to_string(), None)),
                    "tool_result" => Some(block(BlockKind::ToolResult, tool_result_text(&i["content"]), None)),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        },
        Some("assistant") => content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|i| match i["type"].as_str()? {
                "text" => Some(block(BlockKind::Assistant, i["text"].as_str()?.to_string(), None)),
                // 本文が記録されず署名だけの思考ブロックは表示・検索する中身がない
                "thinking" => i["thinking"]
                    .as_str()
                    .filter(|t| !t.trim().is_empty())
                    .map(|t| block(BlockKind::Thinking, t.to_string(), None)),
                "tool_use" => Some(block(
                    BlockKind::ToolUse,
                    serde_json::to_string_pretty(&i["input"]).unwrap_or_default(),
                    i["name"].as_str().map(str::to_string),
                )),
                _ => None,
            })
            .collect(),
        _ => Vec::new(),
    }
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Hit {
    /// どのセッションのファイルか
    pub path: String,
    pub kind: BlockKind,
    /// 当たった箇所の前後の抜粋
    pub snippet: String,
    pub tool_name: Option<String>,
    pub timestamp: Option<String>,
    pub uuid: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub hits: Vec<Hit>,
    /// limit で切る前の総ヒット数
    pub total: usize,
}

/// 全ファイルを並列に走査して、query を含むブロックを新しい順に返す (英字の大文字小文字は区別しない)
pub fn search_files(
    paths: &[std::path::PathBuf],
    query: &str,
    kinds: &std::collections::HashSet<BlockKind>,
    limit: usize,
) -> SearchResult {
    use aho_corasick::AhoCorasick;
    use rayon::prelude::*;
    use std::io::{BufRead, BufReader};

    let Ok(matcher) = AhoCorasick::builder().ascii_case_insensitive(true).build([query]) else {
        return SearchResult { hits: Vec::new(), total: 0 };
    };
    let mut hits: Vec<Hit> = paths
        .par_iter()
        .flat_map_iter(|path| {
            let path_str = path.to_string_lossy().into_owned();
            let mut found = Vec::new();
            let Ok(file) = std::fs::File::open(path) else {
                return found;
            };
            // 数百MBのファイルもあるので、全行を溜めずに 1 行ずつ処理する
            for line in BufReader::new(file).lines().map_while(Result::ok) {
                // JSON として読む前に、行全体に含まれるかだけを速く確かめる
                if !matcher.is_match(&line) {
                    continue;
                }
                for b in parse_line(&line).into_iter().filter(|b| kinds.contains(&b.kind)) {
                    if let Some(m) = matcher.find(&b.text) {
                        found.push(Hit {
                            path: path_str.clone(),
                            kind: b.kind,
                            snippet: snippet(&b.text, m.start(), m.end()),
                            tool_name: b.tool_name,
                            timestamp: b.timestamp,
                            uuid: b.uuid,
                        });
                    }
                }
            }
            found
        })
        .collect();
    let total = hits.len();
    hits.sort_by(|a, b| b.timestamp.cmp(&a.timestamp));
    hits.truncate(limit);
    SearchResult { hits, total }
}

/// 一致箇所 [start, end) の前 40 文字・後ろ 80 文字を切り出す
fn snippet(text: &str, start: usize, end: usize) -> String {
    const BEFORE: usize = 40;
    const AFTER: usize = 80;
    let head: Vec<char> = text[..start].chars().collect();
    let tail: Vec<char> = text[end..].chars().collect();
    let from = head.len().saturating_sub(BEFORE);
    let to = tail.len().min(AFTER);
    format!(
        "{}{}{}{}{}",
        if from > 0 { "…" } else { "" },
        head[from..].iter().collect::<String>(),
        &text[start..end],
        tail[..to].iter().collect::<String>(),
        if to < tail.len() { "…" } else { "" },
    )
    .replace('\n', " ")
}

/// tool_result の content は文字列か、text ブロックの配列
fn tool_result_text(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(|i| i["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n"),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds_and_texts(line: &str) -> Vec<(BlockKind, String)> {
        parse_line(line).into_iter().map(|b| (b.kind, b.text)).collect()
    }

    #[test]
    fn user_string_content_is_user_block() {
        let b = parse_line(r#"{"type":"user","uuid":"u1","timestamp":"T1","message":{"content":"こんにちは"}}"#);
        assert_eq!(b.len(), 1);
        assert_eq!((b[0].kind, b[0].text.as_str()), (BlockKind::User, "こんにちは"));
        assert_eq!((b[0].uuid.as_deref(), b[0].timestamp.as_deref()), (Some("u1"), Some("T1")));
    }

    #[test]
    fn user_array_has_text_and_tool_results() {
        let line = r#"{"type":"user","message":{"content":[
            {"type":"tool_result","content":"ok: 3 files"},
            {"type":"tool_result","content":[{"type":"text","text":"line1"},{"type":"text","text":"line2"}]},
            {"type":"image"},
            {"type":"text","text":"続けて"}]}}"#;
        assert_eq!(
            kinds_and_texts(line),
            [
                (BlockKind::ToolResult, "ok: 3 files".to_string()),
                (BlockKind::ToolResult, "line1\nline2".to_string()),
                (BlockKind::User, "続けて".to_string()),
            ]
        );
    }

    #[test]
    fn empty_thinking_is_skipped() {
        // 思考の本文が記録されず、署名だけが残っている場合がある
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"","signature":"abc"},
            {"type":"text","text":"回答"}]}}"#;
        assert_eq!(kinds_and_texts(line), [(BlockKind::Assistant, "回答".to_string())]);
    }

    #[test]
    fn meta_user_lines_are_skipped() {
        assert!(parse_line(r#"{"type":"user","isMeta":true,"message":{"content":"Caveat"}}"#).is_empty());
    }

    #[test]
    fn assistant_blocks_are_split_by_kind() {
        let line = r#"{"type":"assistant","message":{"content":[
            {"type":"thinking","thinking":"考え中"},
            {"type":"text","text":"回答です"},
            {"type":"tool_use","name":"Bash","input":{"command":"ls"}}]}}"#;
        let b = parse_line(line);
        assert_eq!(
            b.iter().map(|b| (b.kind, b.text.as_str())).collect::<Vec<_>>(),
            [
                (BlockKind::Thinking, "考え中"),
                (BlockKind::Assistant, "回答です"),
                (BlockKind::ToolUse, "{\n  \"command\": \"ls\"\n}"),
            ]
        );
        assert_eq!(b[2].tool_name.as_deref(), Some("Bash"));
    }

    mod search {
        use super::*;
        use std::collections::HashSet;
        use std::fs;
        use tempfile::TempDir;

        fn files(dir: &TempDir, contents: &[&str]) -> Vec<std::path::PathBuf> {
            contents
                .iter()
                .enumerate()
                .map(|(i, c)| {
                    let p = dir.path().join(format!("s{i}.jsonl"));
                    fs::write(&p, c).unwrap();
                    p
                })
                .collect()
        }

        fn all_kinds() -> HashSet<BlockKind> {
            use BlockKind::*;
            HashSet::from([User, Assistant, Thinking, ToolUse, ToolResult])
        }

        const A: &str = concat!(
            r#"{"type":"user","timestamp":"2026-11-01T00:00:00Z","message":{"content":"Error が出ました"}}"#, "\n",
            r#"{"type":"assistant","timestamp":"2026-11-03T00:00:00Z","message":{"content":[{"type":"thinking","thinking":"error の原因"},{"type":"text","text":"直しました"}]}}"#, "\n",
        );
        const B: &str = concat!(
            r#"{"type":"user","timestamp":"2026-11-02T00:00:00Z","message":{"content":[{"type":"tool_result","content":"ERROR: not found"}]}}"#, "\n",
        );

        #[test]
        fn finds_case_insensitively_across_files_in_selected_kinds() {
            let dir = TempDir::new().unwrap();
            let paths = files(&dir, &[A, B]);

            let all = search_files(&paths, "error", &all_kinds(), 100);
            assert_eq!(all.total, 3);

            let only_user = search_files(&paths, "error", &HashSet::from([BlockKind::User]), 100);
            assert_eq!(only_user.hits.len(), 1);
            assert_eq!(only_user.hits[0].kind, BlockKind::User);
            assert_eq!(only_user.hits[0].path, paths[0].to_string_lossy());
            assert_eq!(only_user.hits[0].snippet, "Error が出ました");
        }

        #[test]
        fn newest_first_and_limited() {
            let dir = TempDir::new().unwrap();
            let paths = files(&dir, &[A, B]);

            let r = search_files(&paths, "error", &all_kinds(), 2);

            assert_eq!(r.total, 3);
            let times: Vec<_> = r.hits.iter().map(|h| h.timestamp.as_deref().unwrap()).collect();
            assert_eq!(times, ["2026-11-03T00:00:00Z", "2026-11-02T00:00:00Z"]);
        }

        #[test]
        fn long_text_is_trimmed_around_match() {
            let dir = TempDir::new().unwrap();
            let long = format!("{}KEYWORD{}", "あ".repeat(100), "い".repeat(200));
            let line = format!(r#"{{"type":"user","message":{{"content":"{long}"}}}}"#);
            let paths = files(&dir, &[&line]);

            let r = search_files(&paths, "keyword", &all_kinds(), 10);

            let s = &r.hits[0].snippet;
            assert!(s.starts_with('…') && s.ends_with('…'), "{s}");
            assert!(s.contains("KEYWORD"));
            assert!(s.chars().count() < 150);
        }
    }

    #[test]
    fn load_blocks_truncates_long_tool_output_only() {
        let dir = tempfile::TempDir::new().unwrap();
        let path = dir.path().join("s.jsonl");
        let long = "x".repeat(5000);
        let tool = format!(r#"{{"type":"user","message":{{"content":[{{"type":"tool_result","content":"{long}"}}]}}}}"#);
        let text = format!(r#"{{"type":"assistant","message":{{"content":[{{"type":"text","text":"{long}"}}]}}}}"#);
        std::fs::write(&path, format!("{tool}\n{text}\n")).unwrap();

        let b = load_blocks(&path);

        assert_eq!(b.len(), 2);
        assert_eq!((b[0].text.chars().count(), b[0].truncated), (2000, true));
        assert_eq!((b[1].text.chars().count(), b[1].truncated), (5000, false));
    }

    #[test]
    fn other_types_and_broken_lines_yield_nothing() {
        assert!(parse_line(r#"{"type":"ai-title","aiTitle":"x"}"#).is_empty());
        assert!(parse_line("{broken").is_empty());
    }
}

/// 実データでの検索時間: cargo test --release --lib real_search -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn real_search_timing() {
    use std::collections::HashSet;
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
    let paths: Vec<_> = crate::history::scan_projects(&dir, &Default::default())
        .into_iter()
        .map(|s| std::path::PathBuf::from(s.path))
        .collect();
    let kinds = HashSet::from([BlockKind::User, BlockKind::Assistant, BlockKind::Thinking, BlockKind::ToolUse, BlockKind::ToolResult]);
    for q in ["バッテリー", "error", "決済"] {
        let started = std::time::Instant::now();
        let r = search_files(&paths, q, &kinds, 500);
        println!("{q}: total {} in {:?}", r.total, started.elapsed());
    }
}

/// 最大のセッションを開いたときの量: cargo test --release --lib real_largest -- --ignored --nocapture
#[cfg(test)]
#[test]
#[ignore]
fn real_largest_transcript() {
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
    let largest = crate::history::scan_projects(&dir, &Default::default())
        .into_iter()
        .max_by_key(|s| std::fs::metadata(&s.path).map(|m| m.len()).unwrap_or(0))
        .unwrap();
    let started = std::time::Instant::now();
    let blocks = load_blocks(std::path::Path::new(&largest.path));
    let json = serde_json::to_string(&blocks).unwrap();
    println!("{} blocks, {} MB json, {:?}", blocks.len(), json.len() / 1_000_000, started.elapsed());
}

/// 画面確認用: MOCK_OUT=<dir> MOCK_SESSION=<jsonl> cargo test --lib dump_mock_blocks -- --ignored
#[cfg(test)]
#[test]
#[ignore]
fn dump_mock_blocks() {
    use std::collections::HashSet;
    let out = std::path::PathBuf::from(std::env::var("MOCK_OUT").unwrap());
    let session = std::path::PathBuf::from(std::env::var("MOCK_SESSION").unwrap());
    let blocks = load_blocks(&session);
    std::fs::write(out.join("blocks.json"), serde_json::to_string(&blocks).unwrap()).unwrap();
    let dir = std::path::PathBuf::from(std::env::var("HOME").unwrap()).join(".claude/projects");
    let paths: Vec<_> = crate::history::scan_projects(&dir, &Default::default()).into_iter().map(|s| s.path.into()).collect();
    let kinds = HashSet::from([BlockKind::User, BlockKind::Assistant, BlockKind::Thinking, BlockKind::ToolUse, BlockKind::ToolResult]);
    let result = search_files(&paths, "バッテリー", &kinds, 500);
    std::fs::write(out.join("search.json"), serde_json::to_string(&result).unwrap()).unwrap();
}
