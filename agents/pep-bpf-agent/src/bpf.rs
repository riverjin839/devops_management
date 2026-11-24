//! BPF 시스템 콜 최소 래퍼 — 맵·프로그램을 **읽기 위한** 명령만 쓴다.
//!
//! libbpf/aya 없이 `bpf(2)` 를 직접 부른다. 이 에이전트가 하는 일은 "고정된 맵을 읽기 전용으로 열고,
//! 정보·키를 읽는 것" 뿐이라 의존성을 늘릴 이유가 없고(폐쇄망 반입·정적 빌드), 쓰는 명령이 코드에
//! 드러나야 감사하기 쉽다. 맵 생성·쓰기(`map_create`·`map_update`)는 테스트에서만 컴파일된다.
//!
//! `union bpf_attr`·`struct bpf_map_info`·`struct bpf_prog_info` 오프셋은 커널 uapi(`linux/bpf.h`)를 따른다.
//! 정보 구조체는 커널이 아는 만큼만 채우고 `info_len` 을 줄여 돌려주므로, 오래된 커널에서 없는 필드는
//! `info_len` 으로 판별한다.

use std::ffi::CString;
use std::io;
use std::os::fd::{AsRawFd, FromRawFd, OwnedFd, RawFd};
use std::time::{Duration, Instant};

const BPF_MAP_GET_NEXT_KEY: libc::c_long = 4;
const BPF_OBJ_GET: libc::c_long = 7;
const BPF_PROG_GET_NEXT_ID: libc::c_long = 11;
const BPF_MAP_GET_NEXT_ID: libc::c_long = 12;
const BPF_PROG_GET_FD_BY_ID: libc::c_long = 13;
const BPF_MAP_GET_FD_BY_ID: libc::c_long = 14;
const BPF_OBJ_GET_INFO_BY_FD: libc::c_long = 15;

/// 읽기 전용으로 연다 — 맵 fd 로 쓰기 명령을 보내면 커널이 EPERM 으로 거절한다.
pub const BPF_F_RDONLY: u32 = 1 << 3;

const ATTR_SIZE: usize = 128;

/// `union bpf_attr` 자리 — 쓰는 필드만 오프셋으로 채우고 나머지는 0(커널이 꼬리 0 을 요구한다).
#[repr(C, align(8))]
struct Attr([u8; ATTR_SIZE]);

impl Attr {
    fn new() -> Self {
        Attr([0; ATTR_SIZE])
    }
    fn put_u32(&mut self, off: usize, v: u32) {
        self.0[off..off + 4].copy_from_slice(&v.to_ne_bytes());
    }
    fn put_u64(&mut self, off: usize, v: u64) {
        self.0[off..off + 8].copy_from_slice(&v.to_ne_bytes());
    }
    fn get_u32(&self, off: usize) -> u32 {
        u32::from_ne_bytes(self.0[off..off + 4].try_into().unwrap())
    }
}

fn sys_bpf(cmd: libc::c_long, attr: &mut Attr) -> io::Result<libc::c_long> {
    // SAFETY: attr 는 ATTR_SIZE 바이트의 유효한 버퍼이고, 커널은 그 크기만큼만 읽고 쓴다.
    let r = unsafe {
        libc::syscall(
            libc::SYS_bpf,
            cmd,
            attr.0.as_mut_ptr(),
            ATTR_SIZE as libc::c_uint,
        )
    };
    if r < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(r)
    }
}

fn fd_from(r: libc::c_long) -> OwnedFd {
    // SAFETY: bpf(2) 가 성공하면 새로 연 fd 를 돌려준다 — 소유권을 가져온다.
    unsafe { OwnedFd::from_raw_fd(r as RawFd) }
}

/// 고정 경로의 BPF 객체를 연다(`BPF_OBJ_GET`). 맵이면 `BPF_F_RDONLY` 로 연다.
pub fn obj_get(path: &str, file_flags: u32) -> io::Result<OwnedFd> {
    let c = CString::new(path).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
    let mut a = Attr::new();
    a.put_u64(0, c.as_ptr() as u64);
    a.put_u32(12, file_flags);
    sys_bpf(BPF_OBJ_GET, &mut a).map(fd_from)
}

/// fd 가 맵인지 프로그램인지 — `/proc/self/fd/N` 링크(`anon_inode:bpf-map`)로 판별한다.
pub fn fd_kind(fd: &OwnedFd) -> Option<&'static str> {
    let link = std::fs::read_link(format!("/proc/self/fd/{}", fd.as_raw_fd())).ok()?;
    let s = link.to_string_lossy();
    if s.contains("bpf-map") {
        Some("map")
    } else if s.contains("bpf-prog") {
        Some("prog")
    } else if s.contains("bpf-link") {
        Some("link")
    } else {
        None
    }
}

fn next_id(cmd: libc::c_long, start: u32) -> io::Result<Option<u32>> {
    let mut a = Attr::new();
    a.put_u32(0, start);
    match sys_bpf(cmd, &mut a) {
        Ok(_) => Ok(Some(a.get_u32(4))),
        Err(e) if e.raw_os_error() == Some(libc::ENOENT) => Ok(None),
        Err(e) => Err(e),
    }
}

/// 다음 맵 ID(CAP_SYS_ADMIN 필요).
pub fn map_next_id(start: u32) -> io::Result<Option<u32>> {
    next_id(BPF_MAP_GET_NEXT_ID, start)
}

/// 다음 프로그램 ID(CAP_SYS_ADMIN 필요).
pub fn prog_next_id(start: u32) -> io::Result<Option<u32>> {
    next_id(BPF_PROG_GET_NEXT_ID, start)
}

pub fn map_fd_by_id(id: u32) -> io::Result<OwnedFd> {
    let mut a = Attr::new();
    a.put_u32(0, id);
    a.put_u32(8, BPF_F_RDONLY);
    sys_bpf(BPF_MAP_GET_FD_BY_ID, &mut a).map(fd_from)
}

pub fn prog_fd_by_id(id: u32) -> io::Result<OwnedFd> {
    let mut a = Attr::new();
    a.put_u32(0, id);
    sys_bpf(BPF_PROG_GET_FD_BY_ID, &mut a).map(fd_from)
}

/// 정보 구조체를 읽는다 — 돌려받은 바이트 수(커널이 아는 만큼)와 버퍼.
fn obj_info(fd: &OwnedFd, buf: &mut [u64]) -> io::Result<usize> {
    let mut a = Attr::new();
    a.put_u32(0, fd.as_raw_fd() as u32);
    a.put_u32(4, (buf.len() * 8) as u32);
    a.put_u64(8, buf.as_mut_ptr() as u64);
    sys_bpf(BPF_OBJ_GET_INFO_BY_FD, &mut a)?;
    Ok(a.get_u32(4) as usize)
}

fn bytes(buf: &[u64]) -> Vec<u8> {
    buf.iter().flat_map(|w| w.to_ne_bytes()).collect()
}

fn rd_u32(b: &[u8], off: usize) -> u32 {
    b.get(off..off + 4)
        .map(|s| u32::from_ne_bytes(s.try_into().unwrap()))
        .unwrap_or(0)
}

fn rd_u64(b: &[u8], off: usize) -> u64 {
    b.get(off..off + 8)
        .map(|s| u64::from_ne_bytes(s.try_into().unwrap()))
        .unwrap_or(0)
}

fn rd_name(b: &[u8], off: usize) -> String {
    let raw = &b[off..off + 16];
    let end = raw.iter().position(|&c| c == 0).unwrap_or(16);
    String::from_utf8_lossy(&raw[..end]).into_owned()
}

#[derive(Debug, Clone)]
pub struct MapInfo {
    pub map_type: u32,
    pub id: u32,
    pub key_size: u32,
    pub value_size: u32,
    pub max_entries: u32,
    /// 커널이 보관하는 이름 — 15자에서 잘린다(고정 경로 파일 이름이 전체 이름).
    pub name: String,
}

pub fn map_info(fd: &OwnedFd) -> io::Result<MapInfo> {
    let mut buf = [0u64; 16];
    obj_info(fd, &mut buf)?;
    let b = bytes(&buf);
    Ok(MapInfo {
        map_type: rd_u32(&b, 0),
        id: rd_u32(&b, 4),
        key_size: rd_u32(&b, 8),
        value_size: rd_u32(&b, 12),
        max_entries: rd_u32(&b, 16),
        name: rd_name(&b, 24),
    })
}

#[derive(Debug, Clone)]
pub struct ProgInfo {
    pub prog_type: u32,
    pub tag: String,
    /// 부팅 후 경과(ns) — 로드 시각.
    pub load_time_ns: u64,
    pub name: String,
    /// `kernel.bpf_stats_enabled` 가 켜졌을 때만 0 이 아니다. 5.1 미만 커널은 None.
    pub run_time_ns: Option<u64>,
    pub run_cnt: Option<u64>,
}

pub fn prog_info(fd: &OwnedFd) -> io::Result<ProgInfo> {
    let mut buf = [0u64; 32];
    let len = obj_info(fd, &mut buf)?;
    let b = bytes(&buf);
    let tag = b[8..16]
        .iter()
        .map(|x| format!("{x:02x}"))
        .collect::<String>();
    let has_stats = len >= 208;
    Ok(ProgInfo {
        prog_type: rd_u32(&b, 0),
        tag,
        load_time_ns: rd_u64(&b, 40),
        name: rd_name(&b, 64),
        run_time_ns: has_stats.then(|| rd_u64(&b, 192)),
        run_cnt: has_stats.then(|| rd_u64(&b, 200)),
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct CountResult {
    pub entries: u64,
    /// 시간 예산을 넘겼거나 순회 중 맵이 바뀌어 끝까지 세지 못함 — `entries` 는 그때까지 센 값(하한).
    pub partial: bool,
    pub elapsed: Duration,
}

/// 키를 처음부터 끝까지 따라가며 센다(`BPF_MAP_GET_NEXT_KEY`). 값은 읽지 않는다.
///
/// 순회 중 현재 키가 지워지면 커널은 해시 맵의 첫 키부터 다시 준다 — 같은 키를 두 번 셀 수 있으므로
/// `max_entries` 를 넘으면 멈추고 `partial` 로 표시한다(무한 순회 방지).
pub fn count_keys(
    fd: &OwnedFd,
    key_size: u32,
    max_entries: u32,
    budget: Duration,
) -> io::Result<CountResult> {
    let ks = (key_size as usize).max(1);
    let mut cur = vec![0u8; ks];
    let mut next = vec![0u8; ks];
    let start = Instant::now();
    let mut n: u64 = 0;
    let mut first = true;
    let mut partial = false;
    loop {
        if n & 0xff == 0 && start.elapsed() > budget {
            partial = true;
            break;
        }
        let mut a = Attr::new();
        a.put_u32(0, fd.as_raw_fd() as u32);
        a.put_u64(8, if first { 0 } else { cur.as_ptr() as u64 });
        a.put_u64(16, next.as_mut_ptr() as u64);
        match sys_bpf(BPF_MAP_GET_NEXT_KEY, &mut a) {
            Ok(_) => {
                n += 1;
                std::mem::swap(&mut cur, &mut next);
                first = false;
                if n > max_entries as u64 {
                    n = max_entries as u64;
                    partial = true;
                    break;
                }
            }
            Err(e) if e.raw_os_error() == Some(libc::ENOENT) => break,
            Err(e) => return Err(e),
        }
    }
    Ok(CountResult {
        entries: n,
        partial,
        elapsed: start.elapsed(),
    })
}

/// 사람이 읽는 맵 유형 이름(uapi `enum bpf_map_type`).
pub fn map_type_name(t: u32) -> &'static str {
    match t {
        1 => "HASH",
        2 => "ARRAY",
        3 => "PROG_ARRAY",
        4 => "PERF_EVENT_ARRAY",
        5 => "PERCPU_HASH",
        6 => "PERCPU_ARRAY",
        7 => "STACK_TRACE",
        8 => "CGROUP_ARRAY",
        9 => "LRU_HASH",
        10 => "LRU_PERCPU_HASH",
        11 => "LPM_TRIE",
        12 => "ARRAY_OF_MAPS",
        13 => "HASH_OF_MAPS",
        14 => "DEVMAP",
        15 => "SOCKMAP",
        16 => "CPUMAP",
        17 => "XSKMAP",
        18 => "SOCKHASH",
        19 => "CGROUP_STORAGE",
        20 => "REUSEPORT_SOCKARRAY",
        21 => "PERCPU_CGROUP_STORAGE",
        22 => "QUEUE",
        23 => "STACK",
        24 => "SK_STORAGE",
        25 => "DEVMAP_HASH",
        26 => "STRUCT_OPS",
        27 => "RINGBUF",
        28 => "INODE_STORAGE",
        29 => "TASK_STORAGE",
        30 => "BLOOM_FILTER",
        _ => "UNKNOWN",
    }
}

/// 항목 수가 의미 있는(키를 순회해 셀 수 있는) 유형 — 배열류는 항상 max_entries 만큼 차 있어 제외한다.
pub fn is_countable(t: u32) -> bool {
    matches!(t, 1 | 5 | 9 | 10 | 11 | 13 | 18 | 25)
}

/// 사람이 읽는 프로그램 유형 이름(uapi `enum bpf_prog_type`, 자주 보이는 것만).
pub fn prog_type_name(t: u32) -> &'static str {
    match t {
        1 => "SOCKET_FILTER",
        2 => "KPROBE",
        3 => "SCHED_CLS",
        4 => "SCHED_ACT",
        5 => "TRACEPOINT",
        6 => "XDP",
        7 => "PERF_EVENT",
        8 => "CGROUP_SKB",
        9 => "CGROUP_SOCK",
        13 => "SOCK_OPS",
        14 => "SK_SKB",
        15 => "CGROUP_DEVICE",
        16 => "SK_MSG",
        18 => "CGROUP_SOCK_ADDR",
        26 => "TRACING",
        29 => "LSM",
        30 => "SK_LOOKUP",
        31 => "SYSCALL",
        _ => "OTHER",
    }
}

#[cfg(test)]
pub mod testing {
    //! 테스트 전용 — 맵을 만들고 채우고 고정한다(에이전트 본체에는 컴파일되지 않는다).
    use super::*;

    const BPF_MAP_CREATE: libc::c_long = 0;
    const BPF_MAP_UPDATE_ELEM: libc::c_long = 2;
    const BPF_OBJ_PIN: libc::c_long = 6;

    pub fn map_create(
        map_type: u32,
        key_size: u32,
        value_size: u32,
        max_entries: u32,
        name: &str,
    ) -> io::Result<OwnedFd> {
        let mut a = Attr::new();
        a.put_u32(0, map_type);
        a.put_u32(4, key_size);
        a.put_u32(8, value_size);
        a.put_u32(12, max_entries);
        let nb = name.as_bytes();
        let n = nb.len().min(15);
        a.0[28..28 + n].copy_from_slice(&nb[..n]); // map_name @ 28 (map_flags 16, inner_map_fd 20, numa_node 24)
        sys_bpf(BPF_MAP_CREATE, &mut a).map(fd_from)
    }

    pub fn map_update(fd: &OwnedFd, key: &[u8], value: &[u8]) -> io::Result<()> {
        let mut a = Attr::new();
        a.put_u32(0, fd.as_raw_fd() as u32);
        a.put_u64(8, key.as_ptr() as u64);
        a.put_u64(16, value.as_ptr() as u64);
        sys_bpf(BPF_MAP_UPDATE_ELEM, &mut a).map(|_| ())
    }

    pub fn obj_pin(fd: &OwnedFd, path: &str) -> io::Result<()> {
        let c = CString::new(path).unwrap();
        let mut a = Attr::new();
        a.put_u64(0, c.as_ptr() as u64);
        a.put_u32(8, fd.as_raw_fd() as u32);
        sys_bpf(BPF_OBJ_PIN, &mut a).map(|_| ())
    }
}

#[cfg(test)]
mod tests {
    use super::testing::*;
    use super::*;

    /// 커널이 BPF 맵 생성을 허락하지 않는 환경(비 root CI 등)에서는 건너뛴다.
    fn try_map(max: u32, name: &str) -> Option<OwnedFd> {
        match map_create(1, 4, 8, max, name) {
            Ok(fd) => Some(fd),
            Err(e) => {
                eprintln!("BPF 맵 생성 불가 — 테스트 건너뜀: {e}");
                None
            }
        }
    }

    #[test]
    fn counts_hash_entries_and_reads_info() {
        let Some(fd) = try_map(1024, "pep_test_cnt") else {
            return;
        };
        for k in 0u32..300 {
            map_update(&fd, &k.to_ne_bytes(), &[0u8; 8]).unwrap();
        }
        let info = map_info(&fd).unwrap();
        assert_eq!(info.map_type, 1);
        assert_eq!(info.key_size, 4);
        assert_eq!(info.max_entries, 1024);
        assert_eq!(info.name, "pep_test_cnt");
        let c = count_keys(&fd, info.key_size, info.max_entries, Duration::from_secs(5)).unwrap();
        assert_eq!(c.entries, 300);
        assert!(!c.partial);
        assert_eq!(fd_kind(&fd), Some("map"));
    }

    #[test]
    fn zero_budget_marks_partial() {
        let Some(fd) = try_map(4096, "pep_test_bud") else {
            return;
        };
        for k in 0u32..2000 {
            map_update(&fd, &k.to_ne_bytes(), &[0u8; 8]).unwrap();
        }
        let c = count_keys(&fd, 4, 4096, Duration::ZERO).unwrap();
        assert!(c.partial);
        assert!(c.entries < 2000);
    }

    #[test]
    fn countable_types() {
        assert!(is_countable(9)); // LRU_HASH
        assert!(is_countable(11)); // LPM_TRIE
        assert!(!is_countable(2)); // ARRAY
        assert!(!is_countable(3)); // PROG_ARRAY
        assert_eq!(map_type_name(9), "LRU_HASH");
        assert_eq!(prog_type_name(3), "SCHED_CLS");
    }
}
