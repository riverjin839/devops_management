//! 서비스 구성 설정 파일(containerd `config.toml`·kubelet `config.yaml` 등) — 해시가 바뀐 것만 내용을 함께 보낸다.
use crate::sysctl::host_path;
use serde_json::{json, Map, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::Path;

pub const FILE_MAX: usize = 256 * 1024;

/// 서버가 보고 응답으로 내려준 읽기 대상 — `{id, path}`.
#[derive(Clone, PartialEq, Debug)]
pub struct Target {
    pub id: String,
    pub path: String,
}

pub fn parse_targets(v: Option<&Value>) -> Vec<Target> {
    v.and_then(|x| x.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|t| t.as_object())
                .map(|t| Target {
                    id: t
                        .get("id")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                    path: t
                        .get("path")
                        .and_then(|x| x.as_str())
                        .unwrap_or("")
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default()
}

/// `{id: {path, sha256, content?}}` 또는 `{id: {path, error}}`. `sent`(id → 마지막으로 보낸 해시)와 같으면 내용은 뺀다.
pub fn read_files(
    targets: &[Target],
    host_root: &Path,
    sent: &HashMap<String, String>,
) -> Map<String, Value> {
    let mut out = Map::new();
    for t in targets {
        if t.id.is_empty() || !t.path.starts_with('/') {
            continue;
        }
        let p = host_path(&host_root.join(t.path.trim_start_matches('/')), host_root);
        if !p.is_file() {
            out.insert(
                t.id.clone(),
                json!({"path": t.path, "error": "파일 없음(마운트 확인)"}),
            );
            continue;
        }
        let mut raw = Vec::new();
        let read =
            fs::File::open(&p).and_then(|f| f.take(FILE_MAX as u64 + 1).read_to_end(&mut raw));
        if let Err(e) = read {
            out.insert(
                t.id.clone(),
                json!({"path": t.path, "error": format!("{:?}: {e}", e.kind())}),
            );
            continue;
        }
        if raw.len() > FILE_MAX {
            out.insert(
                t.id.clone(),
                json!({"path": t.path, "error": format!("{FILE_MAX} 바이트 초과")}),
            );
            continue;
        }
        let text = String::from_utf8_lossy(&raw).into_owned();
        let sha = hex(&Sha256::digest(text.as_bytes()));
        let mut entry = json!({"path": t.path, "sha256": sha});
        if sent.get(&t.id).map(String::as_str) != Some(sha.as_str()) {
            entry["content"] = Value::String(text);
        }
        out.insert(t.id.clone(), entry);
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn content_only_when_hash_changed_and_missing_file_is_error() {
        let root = std::env::temp_dir().join(format!("pep-agent-files-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("etc/containerd")).unwrap();
        fs::write(root.join("etc/containerd/config.toml"), "version = 2\n").unwrap();
        let t = vec![
            Target {
                id: "c".into(),
                path: "/etc/containerd/config.toml".into(),
            },
            Target {
                id: "m".into(),
                path: "/etc/none".into(),
            },
        ];
        let first = read_files(&t, &root, &HashMap::new());
        assert_eq!(first["c"]["content"], "version = 2\n");
        assert!(first["m"]["error"].as_str().unwrap().contains("파일 없음"));
        let sha = first["c"]["sha256"].as_str().unwrap().to_string();
        let again = read_files(&t, &root, &HashMap::from([("c".to_string(), sha)]));
        assert!(again["c"].get("content").is_none());
    }
}
