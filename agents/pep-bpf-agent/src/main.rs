//! pep-bpf-agent — 노드마다 뜨는 PEP Cilium 데이터패스 에이전트.
//!
//! 주기마다(기본 5분) 고정된 Cilium BPF 맵을 **읽기 전용**으로 열어 항목 수·최대치를 세고, 요약만 PEP 로
//! 보고한다. 화면의 「지금 수집」은 작업 채널(long-poll)로 바로 전달돼, 단계별 로그를 실시간으로 흘린다.
//!
//! 환경 변수: `PEP_API_URL`(…/api/v1) · `CILIUM_BPF_AGENT_TOKEN` · `PEP_CLUSTER`(UUID 또는 이름) · `NODE_NAME` ·
//! `HOST_IP` · `PEP_TLS_VERIFY`(기본 true) · `PEP_CA_FILE`(사설 CA, 선택).
//!
//! 점검용: `pep-bpf-agent --dry-run [--pin-dir DIR] [--programs] [--scan-all]` — 보내지 않고 수집 결과 JSON 을 출력.

mod bpf;
mod client;
mod collect;
mod sysinfo;

use client::{Client, Env, RemoteSink};
use collect::{CollectCfg, Collection, LogSink, NullSink};
use serde_json::{json, Value};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const VERSION: &str = env!("CARGO_PKG_VERSION");
const TASK_WAIT_SEC: u64 = 25;

fn log(level: &str, msg: &str) {
    eprintln!(
        "{} {:<5} {msg}",
        sysinfo::now_rfc3339(),
        level.to_uppercase()
    );
}

fn report_body(
    env: &Env,
    features: &sysinfo::Features,
    coll: &Collection,
    run_id: Option<&str>,
) -> Value {
    json!({
        "cluster": env.cluster,
        "node": env.node,
        "host_ip": env.host_ip,
        "agent_version": VERSION,
        "collected_at": sysinfo::now_rfc3339(),
        "run_id": run_id,
        "features": features,
        "maps": coll.maps,
        "maps_skipped": coll.maps_skipped,
        "programs": coll.programs,
        "programs_other": coll.programs_other,
        "programs_error": coll.programs_error,
        "errors": coll.errors,
        "collect_ms": coll.collect_ms,
    })
}

/// 보고 응답의 `config` 로 다음 수집 설정을 갱신한다(없거나 깨졌으면 그대로 둔다).
fn apply_config(cfg: &Mutex<CollectCfg>, resp: &Value) {
    if let Some(c) = resp.get("config") {
        match serde_json::from_value::<CollectCfg>(c.clone()) {
            Ok(new) => *cfg.lock().unwrap() = new,
            Err(e) => log("warn", &format!("서버 설정 해석 실패(이전 설정 유지): {e}")),
        }
    }
}

struct Shared {
    client: Client,
    cfg: Mutex<CollectCfg>,
    /// 주기 수집과 수동 수집이 겹치지 않게 한다.
    busy: Mutex<()>,
}

fn periodic(sh: &Shared) {
    let _g = sh.busy.lock().unwrap();
    let cfg = sh.cfg.lock().unwrap().clone();
    let features = sysinfo::detect(&cfg.pin_dirs);
    let coll = collect::collect(&cfg, &mut NullSink);
    match sh
        .client
        .report(&report_body(sh.client.env(), &features, &coll, None))
    {
        Ok(resp) => {
            apply_config(&sh.cfg, &resp);
            log(
                "info",
                &format!(
                    "보고 완료 — 맵 {}개 · {}ms",
                    coll.maps.len(),
                    coll.collect_ms
                ),
            );
        }
        Err(e) => log("error", &format!("보고 실패: {e}")),
    }
}

fn run_task(sh: &Shared, task: &client::Task) {
    let env = sh.client.env();
    let mut sink = RemoteSink::new(&sh.client, &task.run_id);
    sink.log(
        "info",
        format!(
            "{} 작업 수신 (pep-bpf-agent {VERSION}, 종류 {})",
            env.node,
            if task.kind.is_empty() {
                "collect"
            } else {
                &task.kind
            }
        ),
    );
    let _g = match sh.busy.try_lock() {
        Ok(g) => g,
        Err(_) => {
            sink.log("info", "주기 수집이 진행 중 — 끝나면 바로 시작".into());
            sink.flush();
            sh.busy.lock().unwrap()
        }
    };
    let cfg = sh.cfg.lock().unwrap().clone();
    let features = sysinfo::detect(&cfg.pin_dirs);
    sink.log(
        "info",
        format!(
            "커널 {} · CAP_BPF {} · CAP_SYS_ADMIN {} · 맵당 예산 {}ms · 전체 예산 {}ms",
            features.kernel,
            if features.cap_bpf { "있음" } else { "없음" },
            if features.cap_sys_admin {
                "있음"
            } else {
                "없음"
            },
            cfg.map_budget_ms,
            cfg.total_budget_ms
        ),
    );
    let coll = collect::collect(&cfg, &mut sink);
    sink.log(
        "info",
        format!(
            "{} 수집 완료 · 맵 {}개(세지 않은 배열류 {}개) · {}ms — 보고 전송",
            env.node,
            coll.maps.len(),
            coll.maps_skipped,
            coll.collect_ms
        ),
    );
    sink.flush();
    match sh
        .client
        .report(&report_body(env, &features, &coll, Some(&task.run_id)))
    {
        Ok(resp) => apply_config(&sh.cfg, &resp),
        Err(e) => {
            sink.log("error", format!("{} 보고 실패: {e}", env.node));
            sink.flush();
        }
    }
}

fn task_loop(sh: Arc<Shared>) {
    let mut backoff = 5u64;
    loop {
        match sh.client.poll_task(TASK_WAIT_SEC) {
            Ok(Some(task)) => {
                backoff = 5;
                run_task(&sh, &task);
            }
            Ok(None) => backoff = 5,
            Err(e) => {
                log(
                    "warn",
                    &format!("작업 수신 실패({backoff}초 뒤 재시도): {e}"),
                );
                std::thread::sleep(Duration::from_secs(backoff));
                backoff = (backoff * 2).min(60);
            }
        }
    }
}

/// 노드마다 시작 시각이 흩어지도록 ±10% 흔든다.
fn jitter(base: u64) -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.subsec_nanos())
        .unwrap_or(0) as u64;
    let span = (base / 5).max(1);
    Duration::from_secs(base - base / 10 + nanos % span)
}

fn dry_run(args: &[String]) {
    let mut cfg = CollectCfg::default();
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--pin-dir" => {
                if let Some(d) = it.next() {
                    cfg.pin_dirs = vec![d.clone()];
                }
            }
            "--programs" => cfg.program_inventory = true,
            "--scan-all" => cfg.scan_all_ids = true,
            _ => {}
        }
    }
    struct Stderr;
    impl LogSink for Stderr {
        fn log(&mut self, level: &str, message: String) {
            log(level, &message);
        }
    }
    let features = sysinfo::detect(&cfg.pin_dirs);
    let coll = collect::collect(&cfg, &mut Stderr);
    let env = Env {
        api_url: String::new(),
        token: String::new(),
        cluster: "(dry-run)".into(),
        node: std::fs::read_to_string("/proc/sys/kernel/hostname")
            .map(|s| s.trim().to_string())
            .unwrap_or_default(),
        host_ip: None,
        tls_verify: true,
        ca_file: None,
    };
    println!(
        "{}",
        serde_json::to_string_pretty(&report_body(&env, &features, &coll, None)).unwrap()
    );
}

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.iter().any(|a| a == "--version") {
        println!("{VERSION}");
        return;
    }
    if args.iter().any(|a| a == "--dry-run") {
        dry_run(&args);
        return;
    }
    let env = match Env::from_env() {
        Ok(e) => e,
        Err(e) => {
            log("error", &e);
            std::process::exit(2);
        }
    };
    let client = match Client::new(&env) {
        Ok(c) => c,
        Err(e) => {
            log("error", &e);
            std::process::exit(2);
        }
    };
    log(
        "info",
        &format!(
            "pep-bpf-agent {VERSION} 시작 — 클러스터 {} · 노드 {} · {}",
            env.cluster, env.node, env.api_url
        ),
    );
    let sh = Arc::new(Shared {
        client,
        cfg: Mutex::new(CollectCfg::default()),
        busy: Mutex::new(()),
    });
    {
        let sh = sh.clone();
        std::thread::Builder::new()
            .name("tasks".into())
            .spawn(move || task_loop(sh))
            .expect("작업 스레드 시작 실패");
    }
    loop {
        periodic(&sh);
        let interval = sh.cfg.lock().unwrap().interval_sec.clamp(30, 3600);
        std::thread::sleep(jitter(interval));
    }
}
