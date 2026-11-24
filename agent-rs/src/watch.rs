//! 설정 파일 변경 즉시 감지(inotify) — 보고 주기를 기다리지 않고 바뀐 순간 한 번 더 보고하게 한다.
//!
//! 감시 대상은 **디렉터리**다(편집기·구성 도구는 임시 파일을 만들어 rename 으로 교체하므로 파일 자체를 감시하면 놓친다).
//! `/var/lib/kubelet` 처럼 다른 파일이 자주 바뀌는 디렉터리를 보더라도 **이름이 대상과 같은 이벤트만** 깨운다.
//! `/proc/sys` 는 inotify 가 동작하지 않아 런타임 값 변경은 기존처럼 주기 보고로 잡는다.
//! inotify 를 못 쓰는 환경(제한된 fd 등)에서는 조용히 주기 대기로 돌아간다.
use crate::files::Target;
use std::collections::HashMap;
use std::ffi::CString;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};

const SYSCTL_DIRS: [&str; 5] = [
    "etc/sysctl.d",
    "run/sysctl.d",
    "usr/local/lib/sysctl.d",
    "usr/lib/sysctl.d",
    "lib/sysctl.d",
];
const MASK: u32 = libc::IN_CLOSE_WRITE | libc::IN_MOVED_TO | libc::IN_CREATE | libc::IN_DELETE;

/// 한 감시 디렉터리에서 깨울 이름 조건.
#[derive(Default, Clone)]
struct Filter {
    names: Vec<String>,
    /// sysctl.d — `*.conf` 전부.
    conf: bool,
    /// 파일 자체를 감시(이벤트에 이름이 없다) — 이벤트마다 깨운다.
    whole: bool,
}

impl Filter {
    fn matches(&self, name: &str) -> bool {
        self.whole || (self.conf && name.ends_with(".conf")) || self.names.iter().any(|n| n == name)
    }
}

pub struct Watcher {
    fd: libc::c_int,
    filters: HashMap<i32, Filter>,
}

impl Watcher {
    /// inotify 를 열 수 없으면 None — 호출하는 쪽은 주기 대기로 대체한다.
    pub fn new() -> Option<Self> {
        // SAFETY: 인자는 상수이고 반환값을 검사한다.
        let fd = unsafe { libc::inotify_init1(libc::IN_NONBLOCK | libc::IN_CLOEXEC) };
        (fd >= 0).then(|| Watcher {
            fd,
            filters: HashMap::new(),
        })
    }

    fn add(&mut self, path: &Path, filter: Filter) -> bool {
        let Ok(c) = CString::new(path.as_os_str().as_encoded_bytes()) else {
            return false;
        };
        // SAFETY: c 는 NUL 로 끝나는 유효한 경로이고 fd 는 우리가 연 inotify 다.
        let wd = unsafe { libc::inotify_add_watch(self.fd, c.as_ptr(), MASK | libc::IN_MODIFY) };
        if wd < 0 {
            return false;
        }
        // 같은 디렉터리를 두 번 추가하면 같은 wd 가 돌아온다 — 조건을 합친다.
        let e = self.filters.entry(wd).or_default();
        e.conf |= filter.conf;
        e.whole |= filter.whole;
        for n in filter.names {
            if !e.names.contains(&n) {
                e.names.push(n);
            }
        }
        true
    }

    /// 감시 대상을 다시 잡는다 — sysctl 설정 디렉터리 + 서버가 내려준 설정 파일(부모 디렉터리에서 이름만 본다).
    /// 감시를 건 개수를 돌려준다(0 이면 주기 대기만 한다).
    pub fn set_targets(&mut self, host_root: &Path, targets: &[Target]) -> usize {
        for wd in std::mem::take(&mut self.filters).into_keys() {
            // SAFETY: 위에서 받은 유효한 wd 를 제거한다.
            unsafe { libc::inotify_rm_watch(self.fd, wd) };
        }
        let mut n = 0;
        for d in SYSCTL_DIRS {
            n += self.add(
                &host_root.join(d),
                Filter {
                    conf: true,
                    ..Default::default()
                },
            ) as usize;
        }
        n += self.add(
            &host_root.join("etc/sysctl.conf"),
            Filter {
                whole: true,
                ..Default::default()
            },
        ) as usize;
        for t in targets {
            let p: PathBuf = host_root.join(t.path.trim_start_matches('/'));
            let (Some(parent), Some(name)) = (p.parent(), p.file_name()) else {
                continue;
            };
            n += self.add(
                parent,
                Filter {
                    names: vec![name.to_string_lossy().into_owned()],
                    ..Default::default()
                },
            ) as usize;
        }
        n
    }

    /// 대상 파일 변경이 있었는지 — 쌓인 이벤트를 모두 읽어 비운다.
    fn drain(&self) -> bool {
        let mut hit = false;
        let mut buf = [0u8; 8192];
        loop {
            // SAFETY: buf 는 길이만큼 쓸 수 있는 유효한 버퍼다.
            let n = unsafe { libc::read(self.fd, buf.as_mut_ptr().cast(), buf.len()) };
            if n <= 0 {
                break;
            }
            let (mut off, n) = (0usize, n as usize);
            while off + 16 <= n {
                let wd = i32::from_ne_bytes(buf[off..off + 4].try_into().unwrap_or([0; 4]));
                let len = u32::from_ne_bytes(buf[off + 12..off + 16].try_into().unwrap_or([0; 4]))
                    as usize;
                let end = (off + 16 + len).min(n);
                let raw = &buf[off + 16..end];
                let name = String::from_utf8_lossy(
                    &raw[..raw.iter().position(|c| *c == 0).unwrap_or(raw.len())],
                )
                .into_owned();
                if self.filters.get(&wd).is_some_and(|f| f.matches(&name)) {
                    hit = true;
                }
                off = end;
            }
        }
        hit
    }

    /// 최대 `secs` 초 기다린다. 대상 파일이 바뀌면 true(즉시 보고), 시간이 다 되거나 종료 신호면 false.
    pub fn wait(&self, secs: f64, stop: &AtomicBool) -> bool {
        let end = Instant::now() + Duration::from_secs_f64(secs.max(0.0));
        while !stop.load(Ordering::SeqCst) {
            let left = end.saturating_duration_since(Instant::now());
            if left.is_zero() {
                return false;
            }
            let ms = left.min(Duration::from_secs(1)).as_millis().max(1) as libc::c_int;
            let mut p = libc::pollfd {
                fd: self.fd,
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: p 는 유효한 pollfd 하나이고 개수를 1 로 준다.
            let r = unsafe { libc::poll(&mut p, 1, ms) };
            if r > 0 && self.drain() {
                return true;
            }
        }
        false
    }
}

impl Drop for Watcher {
    fn drop(&mut self) {
        // SAFETY: 우리가 연 fd 를 한 번만 닫는다.
        unsafe { libc::close(self.fd) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;

    fn dir(tag: &str) -> PathBuf {
        let d = std::env::temp_dir().join(format!("pep-agent-watch-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&d);
        fs::create_dir_all(d.join("var/lib/kubelet")).unwrap();
        fs::create_dir_all(d.join("etc/sysctl.d")).unwrap();
        d
    }

    fn targets() -> Vec<Target> {
        vec![Target {
            id: "k".into(),
            path: "/var/lib/kubelet/config.yaml".into(),
        }]
    }

    #[test]
    fn wakes_on_target_file_replace_but_not_on_siblings() {
        let root = dir("wake");
        let mut w = Watcher::new().expect("inotify");
        assert!(w.set_targets(&root, &targets()) >= 2);
        stop_free(|stop| {
            // 같은 디렉터리의 다른 파일(kubelet 이 자주 쓴다)은 깨우지 않는다.
            fs::write(root.join("var/lib/kubelet/cpu_manager_state"), "x").unwrap();
            assert!(!w.wait(0.6, stop));
            // 임시 파일을 만들고 rename 으로 교체해도 이름이 같으면 깨운다.
            fs::write(root.join("var/lib/kubelet/config.yaml.tmp"), "a: 1").unwrap();
            fs::rename(
                root.join("var/lib/kubelet/config.yaml.tmp"),
                root.join("var/lib/kubelet/config.yaml"),
            )
            .unwrap();
            assert!(w.wait(2.0, stop));
        });
    }

    #[test]
    fn sysctl_conf_files_wake() {
        let root = dir("sysctl");
        let mut w = Watcher::new().expect("inotify");
        w.set_targets(&root, &[]);
        stop_free(|stop| {
            fs::write(root.join("etc/sysctl.d/99-pep.txt"), "x").unwrap();
            assert!(!w.wait(0.6, stop));
            fs::write(root.join("etc/sysctl.d/99-pep.conf"), "vm.swappiness=1").unwrap();
            assert!(w.wait(2.0, stop));
        });
    }

    fn stop_free(f: impl FnOnce(&AtomicBool)) {
        f(&AtomicBool::new(false));
    }
}
