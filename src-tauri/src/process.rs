//! OS のプロセス情報を扱う。

use crate::live::CmuxLocation;
use std::collections::{HashMap, HashSet};

/// Claude Code のプロセスに SIGTERM を送る。
/// 一覧の読み込み後に PID が別プロセスへ再利用されていないか、送る直前に確かめる。
pub fn terminate_claude(pid: u32) -> Result<(), String> {
    use std::process::Command;
    let ps = Command::new("/bin/ps")
        .args(["-o", "pid=,args=", "-p", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    if !parse_claude_pids(&String::from_utf8_lossy(&ps.stdout)).contains(&pid) {
        return Err(format!("PID {pid} は Claude Code のプロセスではなくなっています。一覧を更新してください"));
    }
    let kill = Command::new("/bin/kill")
        .args(["-TERM", &pid.to_string()])
        .output()
        .map_err(|e| e.to_string())?;
    if kill.status.success() {
        Ok(())
    } else {
        Err(String::from_utf8_lossy(&kill.stderr).trim().to_string())
    }
}

/// `ps eww -o pid=,command= -p <pids>` の出力から、cmux が渡した環境変数で
/// PID → cmux 上の場所 の表を作る (cmux 外で動くプロセスは含まれない)
pub fn parse_cmux_env(ps_output: &str) -> HashMap<u32, CmuxLocation> {
    ps_output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let (mut surface_id, mut workspace_id) = (None, None);
            for field in fields {
                if let Some(v) = field.strip_prefix("CMUX_SURFACE_ID=") {
                    surface_id = Some(v.to_string());
                } else if let Some(v) = field.strip_prefix("CMUX_WORKSPACE_ID=") {
                    workspace_id = Some(v.to_string());
                }
            }
            Some((pid, CmuxLocation { surface_id: surface_id?, workspace_id: workspace_id? }))
        })
        .collect()
}

/// `ps -Ao pid=,ppid=,rss=` の出力から、各 root プロセスとその子孫の RSS 合計 (KB) を出す
pub fn tree_rss_kb(ps_output: &str, roots: &HashSet<u32>) -> HashMap<u32, u64> {
    let mut rss: HashMap<u32, u64> = HashMap::new();
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for line in ps_output.lines() {
        let nums: Vec<u64> = line.split_whitespace().filter_map(|f| f.parse().ok()).collect();
        if let [pid, ppid, kb] = nums[..] {
            rss.insert(pid as u32, kb);
            children.entry(ppid as u32).or_default().push(pid as u32);
        }
    }
    roots
        .iter()
        .filter(|root| rss.contains_key(root))
        .map(|&root| {
            let (mut total, mut stack) = (0, vec![root]);
            while let Some(pid) = stack.pop() {
                total += rss.get(&pid).copied().unwrap_or(0);
                stack.extend(children.get(&pid).into_iter().flatten());
            }
            (root, total)
        })
        .collect()
}

/// `ps -Ao pid=,args=` の出力から Claude Code 本体の PID を取り出す。
/// (プロセス名はバージョン番号になっているため、実行ファイルのパスで判定する)
pub fn parse_claude_pids(ps_output: &str) -> HashSet<u32> {
    ps_output
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            let pid = fields.next()?.parse().ok()?;
            let executable = fields.next()?;
            (executable == "claude" || executable.ends_with("/claude")).then_some(pid)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_processes_whose_executable_is_claude() {
        let ps = "\
    1 /sbin/launchd
13754 /Users/me/.local/bin/claude
14252 claude --resume abc
20000 node /Users/me/.bun/bin/ccstatusline
20001 /usr/bin/grep claude
20002 /Applications/Claude.app/Contents/MacOS/Claude
";
        assert_eq!(parse_claude_pids(ps), HashSet::from([13754, 14252]));
    }

    #[test]
    fn reads_cmux_location_from_process_environment() {
        let ps = "\
13754 /Users/me/.local/bin/claude TERM=xterm CMUX_WORKSPACE_ID=11111111-1111-1111-1111-111111111111 HOME=/Users/me CMUX_SURFACE_ID=22222222-2222-2222-2222-222222222222
14000 /Users/me/.local/bin/claude TERM=xterm HOME=/Users/me
";
        let map = parse_cmux_env(ps);
        assert_eq!(
            map.get(&13754),
            Some(&CmuxLocation {
                surface_id: "22222222-2222-2222-2222-222222222222".into(),
                workspace_id: "11111111-1111-1111-1111-111111111111".into(),
            })
        );
        assert_eq!(map.get(&14000), None);
    }

    mod terminate {
        use super::*;
        use std::process::{Child, Command};

        /// /bin/sleep を「claude」という名前でコピーして起動する (本物のセッションは使わない)。
        /// Apple のシステムバイナリはコピー先では SIGKILL されるので、アドホック署名し直す。
        fn spawn_named(dir: &tempfile::TempDir, name: &str) -> Child {
            let bin = dir.path().join(name);
            std::fs::copy("/bin/sleep", &bin).unwrap();
            let signed = Command::new("/usr/bin/codesign").args(["-f", "-s", "-"]).arg(&bin).output().unwrap();
            assert!(signed.status.success(), "{}", String::from_utf8_lossy(&signed.stderr));
            let child = Command::new(&bin).arg("30").spawn().unwrap();
            std::thread::sleep(std::time::Duration::from_millis(200));
            child
        }

        #[test]
        fn sends_sigterm_to_claude_process() {
            use std::os::unix::process::ExitStatusExt;
            let dir = tempfile::TempDir::new().unwrap();
            let mut child = spawn_named(&dir, "claude");

            terminate_claude(child.id()).unwrap();

            assert_eq!(child.wait().unwrap().signal(), Some(15));
        }

        #[test]
        fn refuses_non_claude_process() {
            let dir = tempfile::TempDir::new().unwrap();
            let mut child = spawn_named(&dir, "not-claude");

            let result = terminate_claude(child.id());

            assert!(result.is_err());
            assert!(child.try_wait().unwrap().is_none(), "claude 以外を止めてはいけない");
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }

    #[test]
    fn sums_rss_of_process_and_all_descendants() {
        // 100(claude) ─┬ 101(mcp) ── 102(watchdog)
        //              └ 103(mcp)
        // 200(claude)   300(他のプロセス)
        let ps = "\
  100     1  1000
  101   100   200
  102   101    30
  103   100   400
  200     1   500
  300     1  9999
";
        let rss = tree_rss_kb(ps, &HashSet::from([100, 200]));
        assert_eq!(rss.get(&100), Some(&1630));
        assert_eq!(rss.get(&200), Some(&500));
        assert_eq!(rss.get(&300), None);
    }
}
