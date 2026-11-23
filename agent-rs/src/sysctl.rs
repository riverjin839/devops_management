//! sysctl — 런타임 값(`/proc/sys`)과 영구 설정 값(sysctl.d 우선순위 계산).
use crate::util::norm;
use serde_json::{json, Map, Value};
use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

/// systemd-sysctl 우선순위 — 같은 파일 이름이면 앞 디렉터리가 이긴다.
const SYSCTL_D_DIRS: [&str; 5] = [
    "etc/sysctl.d",
    "run/sysctl.d",
    "usr/local/lib/sysctl.d",
    "usr/lib/sysctl.d",
    "lib/sysctl.d",
];
const SYSCTL_CONF: &str = "etc/sysctl.conf";

pub fn param_path(proc_sys: &Path, param: &str) -> PathBuf {
    let mut p = proc_sys.to_path_buf();
    for part in param.split('.') {
        p.push(part);
    }
    p
}

/// 감시 파라미터의 현재 값. 없으면 null(모듈 미적재 등), 읽기 권한이 없으면 보고에서 빼고 오류로 남긴다.
pub fn read_runtime(params: &[String], proc_sys: &Path) -> (Map<String, Value>, Vec<String>) {
    let mut values = Map::new();
    let mut errors = Vec::new();
    for p in params {
        match fs::read(param_path(proc_sys, p)) {
            Ok(raw) => {
                values.insert(p.clone(), Value::String(norm(&String::from_utf8_lossy(&raw))));
            }
            Err(e) => match e.kind() {
                std::io::ErrorKind::NotFound => {
                    values.insert(p.clone(), Value::Null);
                }
                std::io::ErrorKind::PermissionDenied => errors.push(format!("{p}: 읽기 권한 없음")),
                _ => errors.push(format!("{p}: {}", io_reason(&e))),
            },
        }
    }
    (values, errors)
}

fn io_reason(e: &std::io::Error) -> String {
    // Python 의 exc.strerror 와 같은 "No such device" 류 문구 — 커널 메시지만 남긴다.
    let s = e.to_string();
    match s.find(" (os error") {
        Some(i) => s[..i].to_string(),
        None => s,
    }
}

/// `(키, 값, 줄번호)` 목록. `-key = v`(적용 실패 무시 표시)는 값이 같으니 `-` 만 뗀다.
pub fn parse_sysctl_file(path: &Path) -> Vec<(String, String, usize)> {
    let Ok(raw) = fs::read(path) else { return Vec::new() };
    let text = String::from_utf8_lossy(&raw);
    let mut out = Vec::new();
    for (i, raw_line) in text.lines().enumerate() {
        let mut line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with(';') {
            continue;
        }
        if let Some(rest) = line.strip_prefix('-') {
            line = rest.trim();
        }
        let Some((key, val)) = line.split_once('=') else { continue };
        let key = key.trim().replace('/', ".");
        if !key.is_empty() {
            out.push((key, norm(val), i + 1));
        }
    }
    out
}

/// 호스트의 절대 경로 심볼릭 링크(예: 99-sysctl.conf → /etc/sysctl.conf)는 컨테이너 안에서 이미지의 파일을
/// 가리키므로 호스트 마운트 위치 기준으로 다시 잇는다. 상대 링크는 마운트 안에서 그대로 풀린다.
pub fn host_path(f: &Path, host_root: &Path) -> PathBuf {
    if let Ok(meta) = fs::symlink_metadata(f) {
        if meta.file_type().is_symlink() {
            if let Ok(target) = fs::read_link(f) {
                if target.is_absolute() {
                    return host_root.join(target.strip_prefix("/").unwrap_or(&target));
                }
            }
        }
    }
    f.to_path_buf()
}

/// 적용 순서대로 정렬된 설정 파일 목록(마지막이 가장 우선).
pub fn sysctl_files(host_root: &Path) -> Vec<PathBuf> {
    let mut by_name: BTreeMap<String, PathBuf> = BTreeMap::new();
    for d in SYSCTL_D_DIRS {
        let Ok(rd) = fs::read_dir(host_root.join(d)) else { continue };
        let mut entries: Vec<PathBuf> = rd
            .filter_map(|e| e.ok().map(|e| e.path()))
            .filter(|p| p.extension().is_some_and(|x| x == "conf"))
            .collect();
        entries.sort();
        for f in entries {
            if let Some(name) = f.file_name().map(|n| n.to_string_lossy().into_owned()) {
                by_name.entry(name).or_insert_with(|| host_path(&f, host_root));
            }
        }
    }
    let mut files: Vec<PathBuf> = by_name.into_values().collect();
    let conf = host_root.join(SYSCTL_CONF);
    if conf.is_file() {
        files.push(conf);
    }
    files
}

fn glob_match(pattern: &str, name: &str) -> bool {
    glob::Pattern::new(pattern).map(|p| p.matches(name)).unwrap_or(false)
}

/// 감시 파라미터의 영구 설정 값과 그 값을 정한 `파일:줄`. 어느 파일에도 없으면 결과에 없다.
pub fn read_persistent(params: &[String], host_root: &Path) -> Map<String, Value> {
    let mut result = Map::new();
    for f in sysctl_files(host_root) {
        let shown = match f.strip_prefix(host_root) {
            Ok(rel) => format!("/{}", rel.display()),
            Err(_) => f.display().to_string(),
        };
        for (key, val, lineno) in parse_sysctl_file(&f) {
            let targets: Vec<&String> = if key.contains(['*', '?', '[']) {
                params.iter().filter(|p| glob_match(&key, p)).collect()
            } else {
                params.iter().filter(|p| **p == key).collect()
            };
            for t in targets {
                result.insert(t.clone(), json!({"value": val, "source": format!("{shown}:{lineno}")}));
            }
        }
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pep-agent-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn runtime_values_are_normalized_and_missing_is_null() {
        let root = tmp("rt");
        fs::create_dir_all(root.join("net/ipv4")).unwrap();
        fs::write(root.join("net/ipv4/tcp_rmem"), "4096\t131072   6291456\n").unwrap();
        let params = vec!["net.ipv4.tcp_rmem".to_string(), "net.nope.x".to_string()];
        let (v, e) = read_runtime(&params, &root);
        assert_eq!(v["net.ipv4.tcp_rmem"], "4096 131072 6291456");
        assert!(v["net.nope.x"].is_null());
        assert!(e.is_empty());
    }

    #[test]
    fn persistent_later_file_wins_and_etc_overrides_usr_lib() {
        let root = tmp("pers");
        fs::create_dir_all(root.join("etc/sysctl.d")).unwrap();
        fs::create_dir_all(root.join("usr/lib/sysctl.d")).unwrap();
        fs::write(root.join("usr/lib/sysctl.d/10-a.conf"), "vm.swappiness = 60\n").unwrap();
        fs::write(root.join("etc/sysctl.d/10-a.conf"), "vm.swappiness = 10\n").unwrap();
        fs::write(root.join("etc/sysctl.d/20-b.conf"), "# c\n-vm.max_map_count=262144\nnet.core.*=1\n").unwrap();
        let params: Vec<String> = ["vm.swappiness", "vm.max_map_count", "net.core.somaxconn"].map(String::from).to_vec();
        let r = read_persistent(&params, &root);
        assert_eq!(r["vm.swappiness"]["value"], "10");
        assert_eq!(r["vm.swappiness"]["source"], "/etc/sysctl.d/10-a.conf:1");
        assert_eq!(r["vm.max_map_count"]["source"], "/etc/sysctl.d/20-b.conf:2");
        assert_eq!(r["net.core.somaxconn"]["value"], "1");
    }

    #[test]
    fn sysctl_conf_is_last() {
        let root = tmp("conf");
        fs::create_dir_all(root.join("etc/sysctl.d")).unwrap();
        fs::write(root.join("etc/sysctl.d/99.conf"), "vm.swappiness=1\n").unwrap();
        fs::write(root.join("etc/sysctl.conf"), "vm.swappiness=5\n").unwrap();
        let r = read_persistent(&["vm.swappiness".to_string()], &root);
        assert_eq!(r["vm.swappiness"]["value"], "5");
    }
}
