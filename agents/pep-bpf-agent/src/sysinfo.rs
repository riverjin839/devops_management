//! 노드·커널 기능 탐지와 시각 변환 — 화면이 "이 노드에서 무엇을 쓸 수 있나" 를 보여주는 근거.

use serde::Serialize;
use std::time::{SystemTime, UNIX_EPOCH};

/// 커널 릴리스 문자열(`6.1.0-27-amd64`) → (major, minor).
pub fn parse_kernel(release: &str) -> Option<(u32, u32)> {
    let mut it = release
        .split(|c: char| !c.is_ascii_digit())
        .filter(|s| !s.is_empty());
    let major = it.next()?.parse().ok()?;
    let minor = it.next()?.parse().ok()?;
    Some((major, minor))
}

pub fn kernel_release() -> String {
    // SAFETY: utsname 은 0 으로 초기화된 POD, uname 은 그 버퍼만 채운다.
    unsafe {
        let mut u: libc::utsname = std::mem::zeroed();
        if libc::uname(&mut u) != 0 {
            return String::new();
        }
        std::ffi::CStr::from_ptr(u.release.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}

/// `/proc/self/status` 의 `CapEff:` 16진수 → 비트 집합.
pub fn parse_cap_eff(status: &str) -> u64 {
    status
        .lines()
        .find_map(|l| l.strip_prefix("CapEff:"))
        .and_then(|v| u64::from_str_radix(v.trim(), 16).ok())
        .unwrap_or(0)
}

pub const CAP_SYS_ADMIN: u32 = 21;
pub const CAP_PERFMON: u32 = 38;
pub const CAP_BPF: u32 = 39;

pub fn has_cap(eff: u64, cap: u32) -> bool {
    eff & (1u64 << cap) != 0
}

#[derive(Debug, Clone, Serialize)]
pub struct Features {
    pub kernel: String,
    pub cap_bpf: bool,
    pub cap_sys_admin: bool,
    pub cap_perfmon: bool,
    /// CAP_BPF 는 5.8 부터 — 그 전 커널은 CAP_SYS_ADMIN 이 있어야 맵을 연다.
    pub kernel_cap_bpf: bool,
    /// 일괄 조회(`BPF_MAP_LOOKUP_BATCH`)는 5.6 부터 — 현재 버전은 키 순회만 쓴다(정보용).
    pub kernel_batch_ops: bool,
    /// `skb:kfree_skb` 의 drop reason 은 5.17 부터 — 커널 드롭 사유 수집(다음 단계)의 전제.
    pub kernel_drop_reason: bool,
    pub btf: bool,
    pub bpf_stats_enabled: bool,
    /// 설정된 고정 경로 중 실제로 있는 것.
    pub pin_dirs_found: Vec<String>,
}

pub fn detect(pin_dirs: &[String]) -> Features {
    let kernel = kernel_release();
    let (maj, min) = parse_kernel(&kernel).unwrap_or((0, 0));
    let ver = maj * 1000 + min;
    let eff = std::fs::read_to_string("/proc/self/status")
        .map(|s| parse_cap_eff(&s))
        .unwrap_or(0);
    let stats = std::fs::read_to_string("/proc/sys/kernel/bpf_stats_enabled")
        .map(|s| s.trim() == "1")
        .unwrap_or(false);
    Features {
        kernel,
        cap_bpf: has_cap(eff, CAP_BPF),
        cap_sys_admin: has_cap(eff, CAP_SYS_ADMIN),
        cap_perfmon: has_cap(eff, CAP_PERFMON),
        kernel_cap_bpf: ver >= 5008,
        kernel_batch_ops: ver >= 5006,
        kernel_drop_reason: ver >= 5017,
        btf: std::path::Path::new("/sys/kernel/btf/vmlinux").exists(),
        bpf_stats_enabled: stats,
        pin_dirs_found: pin_dirs
            .iter()
            .filter(|d| std::path::Path::new(d).is_dir())
            .cloned()
            .collect(),
    }
}

/// 유닉스 초 → `2026-11-24T09:15:02Z`.
pub fn rfc3339(secs: i64) -> String {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let (y, m, d) = civil_from_days(days);
    format!(
        "{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}Z",
        rem / 3600,
        (rem % 3600) / 60,
        rem % 60
    )
}

/// Howard Hinnant 의 days → civil 알고리즘.
fn civil_from_days(z: i64) -> (i64, u32, u32) {
    let z = z + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d)
}

pub fn now_secs() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

pub fn now_rfc3339() -> String {
    rfc3339(now_secs())
}

fn clock_ns(clock: libc::clockid_t) -> i128 {
    // SAFETY: timespec 은 POD, clock_gettime 은 그 버퍼만 채운다.
    unsafe {
        let mut ts: libc::timespec = std::mem::zeroed();
        libc::clock_gettime(clock, &mut ts);
        ts.tv_sec as i128 * 1_000_000_000 + ts.tv_nsec as i128
    }
}

/// 프로그램 `load_time`(부팅 후 ns, CLOCK_BOOTTIME 기준) → 벽시계 RFC3339.
pub fn boot_ns_to_rfc3339(load_time_ns: u64) -> String {
    let boot_epoch_ns = clock_ns(libc::CLOCK_REALTIME) - clock_ns(libc::CLOCK_BOOTTIME);
    rfc3339(((boot_epoch_ns + load_time_ns as i128) / 1_000_000_000) as i64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kernel_parse() {
        assert_eq!(parse_kernel("6.1.0-27-amd64"), Some((6, 1)));
        assert_eq!(parse_kernel("5.4.0-196-generic"), Some((5, 4)));
        assert_eq!(parse_kernel("4.18.0-553.el8_10.x86_64"), Some((4, 18)));
        assert_eq!(parse_kernel(""), None);
    }

    #[test]
    fn cap_parse() {
        let eff = parse_cap_eff("Name:\tx\nCapEff:\t000001fffeffffff\n");
        assert!(has_cap(eff, CAP_BPF));
        assert!(has_cap(eff, CAP_SYS_ADMIN));
        let only_bpf = parse_cap_eff("CapEff:\t0000008000000000\n");
        assert!(has_cap(only_bpf, CAP_BPF));
        assert!(!has_cap(only_bpf, CAP_SYS_ADMIN));
        assert_eq!(parse_cap_eff("nothing"), 0);
    }

    #[test]
    fn time_format() {
        assert_eq!(rfc3339(0), "1970-01-01T00:00:00Z");
        assert_eq!(rfc3339(1_795_477_128), "2026-11-23T23:38:48Z");
        assert_eq!(rfc3339(951_782_400), "2000-02-29T00:00:00Z");
    }
}
