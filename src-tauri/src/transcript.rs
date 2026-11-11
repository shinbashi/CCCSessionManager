//! Claude Code の会話記録 (~/.claude/projects/<dir>/<session>.jsonl) を
//! 1 行ずつ読み、一覧表示に使うタイトルと最後の指示を組み立てる。

use serde_json::Value;

#[derive(Debug, Default)]
pub struct TranscriptSummary {
    /// /rename などでユーザーが付けた名前
    custom_title: Option<String>,
    /// Claude Code が自動で付けたタイトル
    ai_title: Option<String>,
    /// タイトルが無いときの代わりに使う、最初のユーザー発言
    first_user_text: Option<String>,
    /// 最後に送った指示
    last_prompt: Option<String>,
    /// 最初に記録された作業ディレクトリ
    cwd: Option<String>,
    /// 最初に記録された時刻 (ISO 8601)
    first_timestamp: Option<String>,
}

impl TranscriptSummary {
    pub fn feed(&mut self, line: &str) {
        // 会話記録は数百MBになることがあるので、関係しそうな行だけを JSON として読む
        if !self.may_be_relevant(line) {
            return;
        }
        let Ok(entry) = serde_json::from_str::<Value>(line) else {
            return;
        };
        if self.cwd.is_none() {
            self.cwd = entry["cwd"].as_str().map(str::to_string);
        }
        if self.first_timestamp.is_none() {
            self.first_timestamp = entry["timestamp"].as_str().map(str::to_string);
        }
        match entry["type"].as_str() {
            Some("ai-title") => self.ai_title = entry["aiTitle"].as_str().map(str::to_string),
            Some("custom-title") => {
                self.custom_title = entry["customTitle"].as_str().map(str::to_string)
            }
            Some("system") if entry["subtype"] == "local_command" => {
                if let Some(name) = entry["content"].as_str().and_then(legacy_rename_name) {
                    self.custom_title = Some(name);
                }
            }
            Some("user") if self.first_user_text.is_none() => {
                self.first_user_text = genuine_user_text(&entry);
            }
            // lastPrompt を持たない last-prompt 行もあるので、その場合は上書きしない
            Some("last-prompt") => {
                if let Some(p) = entry["lastPrompt"].as_str().filter(|p| !p.trim().is_empty()) {
                    self.last_prompt = Some(p.to_string());
                }
            }
            _ => {}
        }
    }

    /// 文字列検索だけで、確実に無関係な行を除外する (JSON パースより桁違いに速い)
    fn may_be_relevant(&self, line: &str) -> bool {
        const MARKERS: [&str; 4] = [
            "\"ai-title\"",
            "\"custom-title\"",
            "\"last-prompt\"",
            "Session renamed to: ",
        ];
        MARKERS.iter().any(|m| line.contains(m))
            || (self.first_user_text.is_none() && line.contains("\"type\":\"user\""))
            || (self.cwd.is_none() && line.contains("\"cwd\""))
            || (self.first_timestamp.is_none() && line.contains("\"timestamp\""))
    }

    pub fn last_prompt(&self) -> Option<&str> {
        self.last_prompt.as_deref()
    }

    pub fn cwd(&self) -> Option<&str> {
        self.cwd.as_deref()
    }

    pub fn first_timestamp(&self) -> Option<&str> {
        self.first_timestamp.as_deref()
    }

    /// 一覧に出すタイトル。優先順位はリネーム名 > 自動タイトル > 最初の発言
    pub fn title(&self) -> Option<&str> {
        self.custom_title
            .as_deref()
            .or(self.ai_title.as_deref())
            .or(self.first_user_text.as_deref())
    }
}

/// jsonl ファイルを 1 行ずつ読んで要約する
pub fn summarize_file(path: &std::path::Path) -> TranscriptSummary {
    use std::io::{BufRead, BufReader};
    let mut summary = TranscriptSummary::default();
    if let Ok(file) = std::fs::File::open(path) {
        for line in BufReader::new(file).lines().map_while(Result::ok) {
            summary.feed(&line);
        }
    }
    summary
}

/// ユーザーが実際に打ち込んだ文章を取り出す。
/// メタ情報・ツール実行結果・`<command-name>` などのタグで始まる出力は対象外。
fn genuine_user_text(entry: &Value) -> Option<String> {
    if entry["isMeta"] == true {
        return None;
    }
    let content = &entry["message"]["content"];
    let text = match content {
        Value::String(s) => Some(s.as_str()),
        Value::Array(items) => items
            .iter()
            .find(|i| i["type"] == "text")
            .and_then(|i| i["text"].as_str()),
        _ => None,
    }?
    .trim();
    (!text.is_empty() && !text.starts_with('<')).then(|| text.to_string())
}

/// 古い /rename が残す `<local-command-stdout>Session renamed to: 名前</local-command-stdout>` から名前を取り出す
fn legacy_rename_name(content: &str) -> Option<String> {
    let name = content
        .strip_prefix("<local-command-stdout>Session renamed to: ")?
        .strip_suffix("</local-command-stdout>")?
        .trim();
    (!name.is_empty()).then(|| name.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn summarize(lines: &[&str]) -> TranscriptSummary {
        let mut s = TranscriptSummary::default();
        for l in lines {
            s.feed(l);
        }
        s
    }

    #[test]
    fn ai_title_becomes_the_title() {
        let s = summarize(&[r#"{"type":"ai-title","aiTitle":"Macのバッテリー急速消耗","sessionId":"x"}"#]);
        assert_eq!(s.title(), Some("Macのバッテリー急速消耗"));
    }

    #[test]
    fn latest_ai_title_wins() {
        let s = summarize(&[
            r#"{"type":"ai-title","aiTitle":"古いタイトル"}"#,
            r#"{"type":"ai-title","aiTitle":"新しいタイトル"}"#,
        ]);
        assert_eq!(s.title(), Some("新しいタイトル"));
    }

    #[test]
    fn custom_title_beats_ai_title_regardless_of_order() {
        let s = summarize(&[
            r#"{"type":"custom-title","customTitle":"my-project"}"#,
            r#"{"type":"ai-title","aiTitle":"自動タイトル"}"#,
        ]);
        assert_eq!(s.title(), Some("my-project"));
    }

    #[test]
    fn legacy_rename_output_counts_as_custom_title() {
        let s = summarize(&[
            r#"{"type":"ai-title","aiTitle":"自動タイトル"}"#,
            r#"{"type":"system","subtype":"local_command","content":"<local-command-stdout>Session renamed to: follow-pr-loop</local-command-stdout>"}"#,
        ]);
        assert_eq!(s.title(), Some("follow-pr-loop"));
    }

    #[test]
    fn without_titles_first_genuine_user_text_is_used() {
        let s = summarize(&[
            r#"{"type":"user","isMeta":true,"message":{"content":"Caveat: メタ情報"}}"#,
            r#"{"type":"user","message":{"content":"<command-name>/clear</command-name>"}}"#,
            r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"ok"}]}}"#,
            r#"{"type":"user","message":{"content":[{"type":"image"},{"type":"text","text":"このエラーを直して"}]}}"#,
            r#"{"type":"user","message":{"content":"2番目の発言"}}"#,
        ]);
        assert_eq!(s.title(), Some("このエラーを直して"));
    }

    #[test]
    fn title_takes_precedence_over_first_user_text() {
        let s = summarize(&[
            r#"{"type":"user","message":{"content":"最初の発言"}}"#,
            r#"{"type":"ai-title","aiTitle":"自動タイトル"}"#,
        ]);
        assert_eq!(s.title(), Some("自動タイトル"));
    }

    #[test]
    fn last_prompt_keeps_latest_value_and_ignores_entries_without_it() {
        let s = summarize(&[
            r#"{"type":"last-prompt","lastPrompt":"古い指示","leafUuid":"a"}"#,
            r#"{"type":"last-prompt","lastPrompt":"新しい指示","leafUuid":"b"}"#,
            r#"{"type":"last-prompt","leafUuid":"c"}"#,
        ]);
        assert_eq!(s.last_prompt(), Some("新しい指示"));
    }

    #[test]
    fn first_cwd_and_timestamp_are_kept() {
        let s = summarize(&[
            r#"{"type":"last-prompt","lastPrompt":"x"}"#,
            r#"{"type":"user","cwd":"/Users/me/a","timestamp":"2026-11-01T00:00:00.000Z","message":{"content":"hi"}}"#,
            r#"{"type":"assistant","cwd":"/Users/me/b","timestamp":"2026-11-02T00:00:00.000Z","message":{"content":[]}}"#,
        ]);
        assert_eq!(s.cwd(), Some("/Users/me/a"));
        assert_eq!(s.first_timestamp(), Some("2026-11-01T00:00:00.000Z"));
    }

    #[test]
    fn broken_lines_are_ignored() {
        let s = summarize(&[
            r#"{"type":"ai-title","aiTitle":"タイトル"}"#,
            r#"{"type":"ai-title","aiTi"#,
        ]);
        assert_eq!(s.title(), Some("タイトル"));
    }
}
