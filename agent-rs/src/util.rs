//! 공용 유틸 — 로그 포맷·값 정규화·지터.
use chrono::Utc;
use std::sync::atomic::{AtomicU64, Ordering};

/// 한 줄 로그. Python 에이전트와 같은 포맷(`2026-01-01T00:00:00Z INFO  메시지`)이라 로그 수집 규칙이 그대로 통한다.
pub fn log(level: &str, msg: &str) {
    println!("{} {:<5} {}", Utc::now().format("%Y-%m-%dT%H:%M:%SZ"), level, msg);
}

/// 공백(탭 포함)을 한 칸으로 — sysctl 다중 값(`4096\t131072`)을 PEP 와 같은 형태로 맞춘다.
pub fn norm(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

static RNG: AtomicU64 = AtomicU64::new(0);

/// 0 이상 `max` 미만 난수(지터용 — 암호학적 품질 불필요, 노드 500대의 보고 시각을 흩뜨리는 용도).
pub fn jitter(max: f64) -> f64 {
    let mut x = RNG.load(Ordering::Relaxed);
    if x == 0 {
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos() as u64)
            .unwrap_or(1);
        x = nanos ^ ((std::process::id() as u64) << 32) | 1;
    }
    x ^= x << 13;
    x ^= x >> 7;
    x ^= x << 17;
    RNG.store(x, Ordering::Relaxed);
    (x >> 11) as f64 / (1u64 << 53) as f64 * max
}
