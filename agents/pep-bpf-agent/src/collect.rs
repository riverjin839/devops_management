//! 한 번의 수집 — Cilium 맵 사용률과 붙어 있는 프로그램 목록을 모은다.
//!
//! 1. 고정 경로(기본 `/sys/fs/bpf/tc/globals`)의 `cilium_*` 를 `BPF_F_RDONLY` 로 연다 — CAP_BPF 면 된다.
//! 2. (선택) 맵 ID 전체를 훑어 고정되지 않은 `cilium_*` 맵도 찾는다 — CAP_SYS_ADMIN 필요.
//! 3. 항목 수를 셀 수 있는 유형만 키를 순회해 센다(맵당·전체 시간 예산).
//! 4. 엔드포인트마다 생기는 맵(`cilium_policy_v2_01873` 처럼 숫자 꼬리)은 그룹으로 묶어
//!    가장 찬 맵 하나 + 개수만 보낸다(보고 크기를 노드 규모와 무관하게 유지).
//! 5. (선택) 프로그램 목록 — 이름 접두어(`cil_` 등)로 고르고 이름별로 묶는다. CAP_SYS_ADMIN 필요.
//!
//! 원본 키·값은 노드 밖으로 보내지 않는다 — 개수와 메타데이터만.

use crate::bpf;
use crate::sysinfo;
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, HashSet};
use std::time::{Duration, Instant};

/// 서버가 보고 응답으로 내려주는 수집 설정(화면에서 편집 — UI-First).
#[derive(Debug, Clone, Deserialize)]
#[serde(default)]
pub struct CollectCfg {
    pub interval_sec: u64,
    pub map_budget_ms: u64,
    pub total_budget_ms: u64,
    pub pin_dirs: Vec<String>,
    pub map_prefixes: Vec<String>,
    pub scan_all_ids: bool,
    pub program_inventory: bool,
    pub program_prefixes: Vec<String>,
}

impl Default for CollectCfg {
    fn default() -> Self {
        CollectCfg {
            interval_sec: 300,
            map_budget_ms: 2000,
            total_budget_ms: 20_000,
            pin_dirs: vec!["/sys/fs/bpf/tc/globals".into()],
            map_prefixes: vec!["cilium_".into()],
            scan_all_ids: false,
            program_inventory: false,
            program_prefixes: vec!["cil_".into(), "tail_".into()],
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct MapReport {
    /// 고정 경로 파일 이름(전체 이름). 고정되지 않은 맵은 커널 이름(15자에서 잘림).
    pub name: String,
    /// 그룹 키 — 숫자 꼬리를 뗀 이름(`cilium_policy_v2`). 단일 맵은 `name` 과 같다.
    pub group: String,
    pub map_type: String,
    pub id: u32,
    pub key_size: u32,
    pub value_size: u32,
    pub max_entries: u32,
    /// 센 항목 수. 시간 예산이 남지 않아 세지 못했으면 None.
    pub entries: Option<u64>,
    /// 끝까지 세지 못함 — `entries` 는 하한.
    pub partial: bool,
    pub elapsed_ms: u64,
    pub pinned: bool,
    /// 그룹 크기(이 맵은 그룹에서 가장 찬 맵).
    pub members: u32,
    pub error: Option<String>,
}

impl MapReport {
    fn ratio(&self) -> f64 {
        match self.entries {
            Some(e) if self.max_entries > 0 => e as f64 / self.max_entries as f64,
            _ => -1.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct ProgReport {
    pub name: String,
    pub prog_type: String,
    /// 같은 이름 프로그램 수(엔드포인트마다 붙는 프로그램은 여러 개).
    pub count: u32,
    /// 서로 다른 tag(바이트코드 해시) — 최대 8개. 업그레이드·설정 적용 뒤 바뀌면 다시 로드된 것.
    pub tags: Vec<String>,
    pub loaded_at: String,
    pub run_time_ns: Option<u64>,
    pub run_cnt: Option<u64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct Collection {
    pub maps: Vec<MapReport>,
    /// 배열류 등 항목 수를 세지 않는 맵 개수.
    pub maps_skipped: u32,
    pub programs: Vec<ProgReport>,
    /// 접두어에 맞지 않아 목록에서 뺀 프로그램 수.
    pub programs_other: u32,
    /// 프로그램 목록을 못 읽은 사유(권한 없음 등). 수집을 끄면 None.
    pub programs_error: Option<String>,
    pub errors: Vec<String>,
    pub collect_ms: u64,
}

/// 로그 한 줄을 받는 쪽 — 수동 실행이면 PEP 로 흘리고, 주기 수집이면 버린다.
pub trait LogSink {
    fn log(&mut self, level: &str, message: String);
}

pub struct NullSink;
impl LogSink for NullSink {
    fn log(&mut self, _level: &str, _message: String) {}
}

/// 숫자 꼬리(`_01873`, `_4321`)를 뗀 그룹 키. 꼬리가 없으면 그대로.
pub fn group_key(name: &str) -> String {
    if let Some(pos) = name.rfind('_') {
        let tail = &name[pos + 1..];
        if tail.len() >= 2 && tail.chars().all(|c| c.is_ascii_digit()) {
            return name[..pos].to_string();
        }
    }
    name.to_string()
}

struct Candidate {
    name: String,
    pinned: bool,
    fd: std::os::fd::OwnedFd,
    info: bpf::MapInfo,
}

fn matches_prefix(name: &str, prefixes: &[String]) -> bool {
    prefixes.is_empty() || prefixes.iter().any(|p| name.starts_with(p.as_str()))
}

fn discover(cfg: &CollectCfg, out: &mut Collection, sink: &mut dyn LogSink) -> Vec<Candidate> {
    let mut seen: HashSet<u32> = HashSet::new();
    let mut cands = Vec::new();
    for dir in &cfg.pin_dirs {
        let rd = match std::fs::read_dir(dir) {
            Ok(rd) => rd,
            Err(e) => {
                let msg = format!("고정 경로 {dir} 를 읽지 못함: {e}");
                sink.log("warn", msg.clone());
                out.errors.push(msg);
                continue;
            }
        };
        let mut names: Vec<String> = rd
            .filter_map(|e| e.ok())
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        names.sort();
        for name in names {
            if !matches_prefix(&name, &cfg.map_prefixes) {
                continue;
            }
            let path = format!("{}/{}", dir.trim_end_matches('/'), name);
            let fd = match bpf::obj_get(&path, bpf::BPF_F_RDONLY) {
                Ok(fd) => fd,
                Err(e) => {
                    out.errors.push(format!("{name}: 열기 실패 {e}"));
                    continue;
                }
            };
            if bpf::fd_kind(&fd) != Some("map") {
                continue;
            }
            match bpf::map_info(&fd) {
                Ok(info) => {
                    if seen.insert(info.id) {
                        cands.push(Candidate {
                            name,
                            pinned: true,
                            fd,
                            info,
                        });
                    }
                }
                Err(e) => out.errors.push(format!("{name}: 정보 읽기 실패 {e}")),
            }
        }
    }
    sink.log(
        "info",
        format!(
            "고정 경로에서 맵 {}개 찾음 ({})",
            cands.len(),
            cfg.pin_dirs.join(", ")
        ),
    );

    if cfg.scan_all_ids {
        let mut id = 0u32;
        let mut extra = 0;
        loop {
            match bpf::map_next_id(id) {
                Ok(Some(next)) => {
                    id = next;
                    if seen.contains(&next) {
                        continue;
                    }
                    let Ok(fd) = bpf::map_fd_by_id(next) else {
                        continue;
                    };
                    let Ok(info) = bpf::map_info(&fd) else {
                        continue;
                    };
                    if !matches_prefix(&info.name, &cfg.map_prefixes) {
                        continue;
                    }
                    seen.insert(next);
                    extra += 1;
                    cands.push(Candidate {
                        name: info.name.clone(),
                        pinned: false,
                        fd,
                        info,
                    });
                }
                Ok(None) => break,
                Err(e) => {
                    let msg = format!("맵 ID 전체 조회 실패(CAP_SYS_ADMIN 필요): {e}");
                    sink.log("warn", msg.clone());
                    out.errors.push(msg);
                    break;
                }
            }
        }
        sink.log(
            "info",
            format!("맵 ID 전체 조회 — 고정되지 않은 맵 {extra}개 추가"),
        );
    }
    cands
}

pub fn collect(cfg: &CollectCfg, sink: &mut dyn LogSink) -> Collection {
    let t0 = Instant::now();
    let mut out = Collection::default();
    let cands = discover(cfg, &mut out, sink);

    // 그룹 크기 — 단일 맵 먼저(용량 알람의 핵심), 엔드포인트별 맵 그룹은 나중에 센다.
    let mut group_size: BTreeMap<String, u32> = BTreeMap::new();
    for c in &cands {
        *group_size.entry(group_key(&c.name)).or_default() += 1;
    }
    let mut order: Vec<&Candidate> = cands.iter().collect();
    order.sort_by_key(|c| (group_size[&group_key(&c.name)] > 1, c.name.clone()));

    let map_budget = Duration::from_millis(cfg.map_budget_ms);
    let total_budget = Duration::from_millis(cfg.total_budget_ms);
    let mut reports: Vec<MapReport> = Vec::new();
    let mut budget_note = false;
    for c in order {
        let group = group_key(&c.name);
        let mut r = MapReport {
            name: c.name.clone(),
            group: group.clone(),
            map_type: bpf::map_type_name(c.info.map_type).into(),
            id: c.info.id,
            key_size: c.info.key_size,
            value_size: c.info.value_size,
            max_entries: c.info.max_entries,
            entries: None,
            partial: false,
            elapsed_ms: 0,
            pinned: c.pinned,
            members: 1,
            error: None,
        };
        if !bpf::is_countable(c.info.map_type) {
            out.maps_skipped += 1;
            continue;
        }
        let left = total_budget.saturating_sub(t0.elapsed());
        if left.is_zero() {
            if !budget_note {
                sink.log(
                    "warn",
                    format!(
                        "전체 시간 예산 {}ms 소진 — 남은 맵은 세지 않음",
                        cfg.total_budget_ms
                    ),
                );
                budget_note = true;
            }
            r.partial = true;
            reports.push(r);
            continue;
        }
        match bpf::count_keys(
            &c.fd,
            c.info.key_size,
            c.info.max_entries,
            map_budget.min(left),
        ) {
            Ok(cnt) => {
                r.entries = Some(cnt.entries);
                r.partial = cnt.partial;
                r.elapsed_ms = cnt.elapsed.as_millis() as u64;
                if group_size[&group] == 1 {
                    let pct = if c.info.max_entries > 0 {
                        cnt.entries as f64 * 100.0 / c.info.max_entries as f64
                    } else {
                        0.0
                    };
                    let level = if cnt.partial { "warn" } else { "info" };
                    sink.log(
                        level,
                        format!(
                            "{} {} max={} → {}건 ({:.1}%){} · {}ms",
                            c.name,
                            r.map_type,
                            c.info.max_entries,
                            cnt.entries,
                            pct,
                            if cnt.partial {
                                " · 부분 집계(하한)"
                            } else {
                                ""
                            },
                            r.elapsed_ms
                        ),
                    );
                }
            }
            Err(e) => {
                r.error = Some(e.to_string());
                sink.log("warn", format!("{} 순회 실패: {e}", c.name));
            }
        }
        reports.push(r);
    }

    // 그룹 축약 — 가장 찬 맵 하나만 남기고 members 에 개수.
    let mut grouped: BTreeMap<String, MapReport> = BTreeMap::new();
    for r in reports {
        let size = group_size[&r.group];
        match grouped.get_mut(&r.group) {
            Some(cur) => {
                if r.ratio() > cur.ratio() {
                    let partial = cur.partial || r.partial;
                    *cur = MapReport {
                        members: size,
                        partial,
                        ..r
                    };
                } else if r.partial {
                    cur.partial = true;
                }
            }
            None => {
                grouped.insert(r.group.clone(), MapReport { members: size, ..r });
            }
        }
    }
    for r in grouped.values().filter(|r| r.members > 1) {
        sink.log(
            "info",
            format!(
                "{}_* {}개 — 가장 찬 맵 {} {}/{}{}",
                r.group,
                r.members,
                r.name,
                r.entries
                    .map(|e| e.to_string())
                    .unwrap_or_else(|| "-".into()),
                r.max_entries,
                if r.partial {
                    " · 일부 부분 집계"
                } else {
                    ""
                }
            ),
        );
    }
    out.maps = grouped.into_values().collect();

    if cfg.program_inventory {
        match programs(cfg) {
            Ok((progs, other)) => {
                sink.log(
                    "info",
                    format!("프로그램 {}종 (접두어 밖 {}개 제외)", progs.len(), other),
                );
                out.programs = progs;
                out.programs_other = other;
            }
            Err(e) => {
                let msg = format!("프로그램 목록 실패(CAP_SYS_ADMIN 필요): {e}");
                sink.log("warn", msg.clone());
                out.programs_error = Some(msg);
            }
        }
    }
    out.collect_ms = t0.elapsed().as_millis() as u64;
    out
}

fn programs(cfg: &CollectCfg) -> std::io::Result<(Vec<ProgReport>, u32)> {
    let mut by: BTreeMap<String, (ProgReport, u64)> = BTreeMap::new();
    let mut other = 0u32;
    let mut id = 0u32;
    let mut first_err: Option<std::io::Error> = None;
    let mut any = false;
    while let Some(next) = bpf::prog_next_id(id)? {
        id = next;
        let info = match bpf::prog_fd_by_id(next).and_then(|fd| bpf::prog_info(&fd)) {
            Ok(i) => i,
            Err(e) => {
                first_err.get_or_insert(e);
                continue;
            }
        };
        any = true;
        if !matches_prefix(&info.name, &cfg.program_prefixes) {
            other += 1;
            continue;
        }
        let e = by.entry(info.name.clone()).or_insert_with(|| {
            (
                ProgReport {
                    name: info.name.clone(),
                    prog_type: bpf::prog_type_name(info.prog_type).into(),
                    count: 0,
                    tags: Vec::new(),
                    loaded_at: String::new(),
                    run_time_ns: info.run_time_ns.map(|_| 0),
                    run_cnt: info.run_cnt.map(|_| 0),
                },
                0,
            )
        });
        e.0.count += 1;
        if !e.0.tags.contains(&info.tag) && e.0.tags.len() < 8 {
            e.0.tags.push(info.tag.clone());
        }
        if info.load_time_ns >= e.1 {
            e.1 = info.load_time_ns;
        }
        if let (Some(a), Some(b)) = (e.0.run_time_ns.as_mut(), info.run_time_ns) {
            *a += b;
        }
        if let (Some(a), Some(b)) = (e.0.run_cnt.as_mut(), info.run_cnt) {
            *a += b;
        }
    }
    if !any {
        if let Some(e) = first_err {
            return Err(e);
        }
    }
    let progs = by
        .into_values()
        .map(|(mut p, latest)| {
            p.tags.sort();
            p.loaded_at = sysinfo::boot_ns_to_rfc3339(latest);
            p
        })
        .collect();
    Ok((progs, other))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::bpf::testing::*;

    #[test]
    fn group_keys() {
        assert_eq!(group_key("cilium_policy_v2_01873"), "cilium_policy_v2");
        assert_eq!(group_key("cilium_calls_00042"), "cilium_calls");
        assert_eq!(
            group_key("cilium_lb4_backends_v3"),
            "cilium_lb4_backends_v3"
        );
        assert_eq!(group_key("cilium_ct4_global"), "cilium_ct4_global");
        assert_eq!(group_key("cilium_x_1"), "cilium_x_1"); // 한 자리 숫자는 버전 꼬리로 본다
    }

    struct VecSink(Vec<(String, String)>);
    impl LogSink for VecSink {
        fn log(&mut self, level: &str, message: String) {
            self.0.push((level.into(), message));
        }
    }

    /// 실제 bpffs 에 맵을 고정해 놓고 수집 경로 전체를 돌린다(권한 없으면 건너뜀).
    #[test]
    fn collect_from_pinned_dir() {
        let dir = format!("/sys/fs/bpf/pep-agent-test-{}", std::process::id());
        if std::fs::create_dir_all(&dir).is_err() {
            eprintln!("bpffs 없음 — 건너뜀");
            return;
        }
        let ct = match map_create(9, 4, 8, 1000, "cilium_ct4_glob") {
            Ok(fd) => fd,
            Err(e) => {
                eprintln!("BPF 맵 생성 불가 — 건너뜀: {e}");
                let _ = std::fs::remove_dir(&dir);
                return;
            }
        };
        for k in 0u32..870 {
            map_update(&ct, &k.to_ne_bytes(), &[0u8; 8]).unwrap();
        }
        obj_pin(&ct, &format!("{dir}/cilium_ct4_global")).unwrap();
        let arr = map_create(2, 4, 8, 16, "cilium_arr").unwrap();
        obj_pin(&arr, &format!("{dir}/cilium_calls_hostns")).unwrap();
        for (i, fill) in [(1873u32, 10u32), (2001, 300), (2002, 50)] {
            let p = map_create(1, 4, 8, 400, "cilium_pol").unwrap();
            for k in 0..fill {
                map_update(&p, &k.to_ne_bytes(), &[0u8; 8]).unwrap();
            }
            obj_pin(&p, &format!("{dir}/cilium_policy_v2_{i:05}")).unwrap();
        }
        let other = map_create(1, 4, 8, 8, "not_cilium").unwrap();
        obj_pin(&other, &format!("{dir}/other_map")).unwrap();

        let cfg = CollectCfg {
            pin_dirs: vec![dir.clone()],
            ..CollectCfg::default()
        };
        let mut sink = VecSink(Vec::new());
        let out = collect(&cfg, &mut sink);
        let _ = std::fs::remove_dir_all(&dir);

        assert!(out.errors.is_empty(), "{:?}", out.errors);
        assert_eq!(out.maps_skipped, 1, "배열 맵은 세지 않는다");
        let names: Vec<&str> = out.maps.iter().map(|m| m.name.as_str()).collect();
        assert_eq!(names, vec!["cilium_ct4_global", "cilium_policy_v2_02001"]);
        let ct = &out.maps[0];
        assert_eq!(
            (ct.entries, ct.max_entries, ct.partial, ct.members),
            (Some(870), 1000, false, 1)
        );
        assert_eq!(ct.map_type, "LRU_HASH");
        assert!(ct.pinned);
        let pol = &out.maps[1];
        assert_eq!(
            (pol.group.as_str(), pol.entries, pol.members),
            ("cilium_policy_v2", Some(300), 3)
        );
        assert!(sink
            .0
            .iter()
            .any(|(_, m)| m.contains("cilium_ct4_global") && m.contains("87.0%")));
    }
}
