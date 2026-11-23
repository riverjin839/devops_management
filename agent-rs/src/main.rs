//! PEP 노드 에이전트 — DaemonSet 으로 노드마다 떠서 sysctl·서비스 설정 파일 상태를 PEP 로 보고한다.
//! Python `app.node_param_agent` 와 같은 환경 변수·보고 프로토콜·로그 포맷을 쓴다(서버 무변경).
//!
//! 한 주기: ① 감시 파라미터 런타임 값(`/proc/sys`) ② 영구 설정 값(sysctl.d 우선순위) ③ 서비스 구성 파일 해시(+변경분 내용)
//! ④ `POST {PEP_API_URL}/node-params/agent/report` — 응답의 `params`·`files`·`interval_sec` 로 다음 주기를 정한다.
//!
//! 환경 변수: PEP_API_URL · NODE_PARAM_INGEST_TOKEN · PEP_CLUSTER · NODE_NAME · HOST_IP · HOST_ROOT(기본 /host) ·
//! PEP_TLS_VERIFY(기본 true) · PEP_CA_FILE · PROC_SYS(기본 /proc/sys)
//!
//! 점검용: `pep-node-agent --dry-run --param net.core.somaxconn` — 보내지 않고 읽은 값만 출력.
mod files;
mod nic;
mod report;
mod sysctl;
mod util;

use chrono::{SecondsFormat, Utc};
use files::Target;
use report::{ReportError, AGENT_VERSION};
use serde_json::{json, Map, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use util::{jitter, log};

static STOP: AtomicBool = AtomicBool::new(false);

extern "C" fn on_signal(signum: libc::c_int) {
    STOP.store(true, Ordering::SeqCst);
    // 시그널 핸들러에서는 안전한 호출만 — 로그는 메인 루프가 남긴다.
    let _ = signum;
}

fn install_signals() {
    // SAFETY: 핸들러는 원자 변수 하나만 갱신한다(async-signal-safe).
    unsafe {
        libc::signal(
            libc::SIGTERM,
            on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
        libc::signal(
            libc::SIGINT,
            on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t,
        );
    }
}

fn sleep(seconds: f64) {
    let end = Instant::now() + Duration::from_secs_f64(seconds.max(0.0));
    while !STOP.load(Ordering::SeqCst) {
        let left = end.saturating_duration_since(Instant::now());
        if left.is_zero() {
            break;
        }
        std::thread::sleep(left.min(Duration::from_secs(1)));
    }
}

fn env(name: &str) -> String {
    std::env::var(name).unwrap_or_default().trim().to_string()
}

fn host_root() -> PathBuf {
    PathBuf::from(std::env::var("HOST_ROOT").unwrap_or_else(|_| "/host".into()))
}

fn proc_sys() -> PathBuf {
    PathBuf::from(std::env::var("PROC_SYS").unwrap_or_else(|_| "/proc/sys".into()))
}

fn run(once: bool) -> i32 {
    let api = env("PEP_API_URL").trim_end_matches('/').to_string();
    let token = env("NODE_PARAM_INGEST_TOKEN");
    let cluster = env("PEP_CLUSTER");
    let node = Some(env("NODE_NAME"))
        .filter(|n| !n.is_empty())
        .unwrap_or_else(|| {
            std::fs::read_to_string("/proc/sys/kernel/hostname")
                .map(|s| s.trim().to_string())
                .unwrap_or_default()
        });
    let host_ip = env("HOST_IP");
    let host_root = host_root();
    let proc_sys = proc_sys();
    let verify = !matches!(
        env("PEP_TLS_VERIFY").to_lowercase().as_str(),
        "0" | "false" | "no" | "off"
    );

    let missing: Vec<&str> = [
        ("PEP_API_URL", &api),
        ("NODE_PARAM_INGEST_TOKEN", &token),
        ("PEP_CLUSTER", &cluster),
    ]
    .iter()
    .filter(|(_, v)| v.is_empty())
    .map(|(n, _)| *n)
    .collect();
    if !missing.is_empty() {
        log(
            "ERROR",
            &format!(
                "필수 환경 변수가 없습니다: {} — Secret 을 확인하세요",
                missing.join(", ")
            ),
        );
        return 2;
    }
    let ca = env("PEP_CA_FILE");
    let agent = match report::build_agent(verify, Some(&ca)) {
        Ok(a) => a,
        Err(e) => {
            log("ERROR", &e);
            return 2;
        }
    };

    let url = format!("{api}/node-params/agent/report");
    log(
        "INFO",
        &format!(
            "시작 v{AGENT_VERSION} node={node} host_ip={} cluster={cluster} → {url} (TLS 검증 {})",
            if host_ip.is_empty() { "-" } else { &host_ip },
            if verify { "켬" } else { "끔" }
        ),
    );

    let mut params: Vec<String> = Vec::new();
    let mut file_targets: Vec<Target> = Vec::new();
    let mut sent_hashes: HashMap<String, String> = HashMap::new();
    // 첫 응답 전엔 NIC 설정을 모른다 — 받은 뒤부터 수집한다(끄면 보내지 않는다).
    let mut nic_cfg: Option<Map<String, Value>> = None;
    let mut interval: u64 = 60;
    let mut failures: u32 = 0;

    while !STOP.load(Ordering::SeqCst) {
        let (runtime, errors) = sysctl::read_runtime(&params, &proc_sys);
        let persistent = if params.is_empty() {
            Map::new()
        } else {
            sysctl::read_persistent(&params, &host_root)
        };
        let files = files::read_files(&file_targets, &host_root, &sent_hashes);
        let nic_report = match &nic_cfg {
            Some(cfg)
                if cfg
                    .get("enabled")
                    .and_then(|v| v.as_bool())
                    .unwrap_or(false) =>
            {
                Some(nic::collect_default(Some(cfg)))
            }
            _ => None,
        };
        let mut payload = json!({
            "cluster": cluster, "node": node, "host_ip": host_ip, "agent_version": AGENT_VERSION,
            "collected_at": Utc::now().to_rfc3339_opts(SecondsFormat::Micros, false),
            "runtime": runtime, "persistent": persistent, "errors": errors, "files": files,
        });

        if let Some(n) = &nic_report {
            payload["nic"] = n.clone();
        }
        let mut first_list = false;
        match report::post_report(&agent, &url, &token, &payload) {
            Ok(resp) => {
                failures = 0;
                let new_params: Vec<String> = resp
                    .get("params")
                    .and_then(|v| v.as_array())
                    .map(|a| {
                        a.iter()
                            .filter_map(|p| p.as_str().map(String::from))
                            .collect()
                    })
                    .unwrap_or_default();
                first_list = params.is_empty() && !new_params.is_empty();
                let same = new_params.len() == params.len()
                    && new_params.iter().all(|p| params.contains(p));
                if !same {
                    log(
                        "INFO",
                        &format!("감시 목록 갱신 {} → {}개", params.len(), new_params.len()),
                    );
                }
                params = new_params;
                for (fid, f) in &files {
                    if let (Some(sha), true) = (
                        f.get("sha256").and_then(|s| s.as_str()),
                        f.get("content").is_some(),
                    ) {
                        sent_hashes.insert(fid.clone(), sha.to_string());
                    }
                }
                let new_targets = files::parse_targets(resp.get("files"));
                if new_targets != file_targets {
                    first_list = first_list || (file_targets.is_empty() && !new_targets.is_empty());
                    file_targets = new_targets;
                    sent_hashes.clear();
                }
                let new_nic = resp.get("nic").and_then(|v| v.as_object()).cloned();
                let enabled = |c: &Option<Map<String, Value>>| {
                    c.as_ref()
                        .and_then(|m| m.get("enabled"))
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                };
                if nic_cfg.is_none() && enabled(&new_nic) {
                    first_list = true; // NIC 설정을 막 받았다 — 바로 NIC 상태까지 보고
                }
                nic_cfg = new_nic;
                interval = resp
                    .get("interval_sec")
                    .and_then(|v| v.as_u64())
                    .filter(|v| *v > 0)
                    .unwrap_or(interval);
                let n = |k: &str| resp.get(k).and_then(|v| v.as_u64()).unwrap_or(0);
                let stored = resp
                    .get("files_stored")
                    .and_then(|v| v.as_array())
                    .map_or(0, |a| a.len());
                log("INFO", &format!(
                    "보고 완료 파라미터 {}개 · 영구 설정 {}개 · 변경 {}건 · 기준 위반 {} · 영구 설정 불일치 {} · 알람 열림 {}/닫힘 {} · 설정 파일 {}개(저장 {}) · NIC {}개 · 다음 {}초 뒤",
                    runtime.len(), persistent.len(), n("changes"), n("violations"), n("mismatches"),
                    n("alerts_opened"), n("alerts_resolved"), files.len(), stored,
                    nic_report.as_ref().map_or("-".to_string(), |r| r["interfaces"].as_array().map_or(0, |a| a.len()).to_string()), interval
                ));
                for e in &errors {
                    log("WARN", &format!("읽기 오류 {e}"));
                }
                for (fid, f) in &files {
                    if let Some(err) = f.get("error").and_then(|e| e.as_str()) {
                        let path = f.get("path").and_then(|p| p.as_str()).unwrap_or("");
                        log("WARN", &format!("설정 파일 {fid} {path}: {err}"));
                    }
                }
                for e in nic_report
                    .as_ref()
                    .and_then(|r| r["errors"].as_array())
                    .into_iter()
                    .flatten()
                {
                    log("WARN", &format!("NIC 읽기 오류 {e}"));
                }
                for e in resp
                    .get("file_errors")
                    .and_then(|v| v.as_array())
                    .into_iter()
                    .flatten()
                {
                    log("WARN", &format!("설정 파일 처리 오류(서버) {e}"));
                }
            }
            Err(ReportError::Http(code, body)) => {
                failures += 1;
                let hint = match code {
                    401 => "토큰 불일치",
                    503 => "PEP 에 NODE_PARAM_INGEST_TOKEN 미설정",
                    404 => "클러스터를 찾지 못함(PEP_CLUSTER 확인)",
                    _ => "",
                };
                log(
                    "ERROR",
                    format!("보고 실패 HTTP {code} {hint} {body}").trim(),
                );
            }
            Err(ReportError::Other(e)) => {
                failures += 1;
                log("ERROR", &format!("보고 실패 {e}"));
            }
        }
        if first_list {
            continue; // 목록을 막 받았으면 바로 실제 값을 보고한다
        }
        if once {
            return if failures == 0 { 0 } else { 1 };
        }
        let wait = if failures == 0 {
            interval
        } else {
            interval.min(10 * (1u64 << (failures - 1).min(4)))
        };
        sleep(wait as f64 + jitter(10f64.min(interval as f64 * 0.1)));
    }
    log("INFO", "종료 신호 수신 — 종료합니다");
    0
}

fn dry_run(params: &[String], with_nic: bool) -> i32 {
    let (host_root, proc_sys) = (host_root(), proc_sys());
    let (runtime, errors) = sysctl::read_runtime(params, &proc_sys);
    let persistent = sysctl::read_persistent(params, &host_root);
    let files: Vec<String> = sysctl::sysctl_files(&host_root)
        .iter()
        .map(|f| f.display().to_string())
        .collect();
    let mut out =
        json!({"runtime": runtime, "persistent": persistent, "errors": errors, "files": files});
    if with_nic {
        out["nic"] = nic::collect_default(None);
    }
    println!("{}", serde_json::to_string_pretty(&out).unwrap_or_default());
    0
}

fn main() {
    let mut once = false;
    let mut dry = false;
    let mut with_nic = false;
    let mut params: Vec<String> = Vec::new();
    let mut args = std::env::args().skip(1);
    while let Some(a) = args.next() {
        match a.as_str() {
            "--once" => once = true,
            "--dry-run" => dry = true,
            "--nic" => with_nic = true,
            "--param" => match args.next() {
                Some(p) => params.push(p),
                None => {
                    eprintln!("--param 에 파라미터 이름이 필요합니다");
                    std::process::exit(2);
                }
            },
            "-h" | "--help" => {
                println!("pep-node-agent [--once] [--dry-run [--nic] --param <sysctl 키>...]\n  --once     한 번만 보고하고 종료\n  --dry-run  보내지 않고 읽은 값만 출력");
                return;
            }
            other => {
                eprintln!("알 수 없는 옵션: {other}");
                std::process::exit(2);
            }
        }
    }
    if dry {
        std::process::exit(dry_run(&params, with_nic));
    }
    install_signals();
    std::process::exit(run(once));
}
