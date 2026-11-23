//! NIC 상태 수집 — 본딩/LACP·링크·MTU·ring buffer·offload·드롭 카운터.
//!
//! 읽는 곳(전부 읽기 전용, 루트·CAP_NET_ADMIN 불필요):
//! - `/sys/class/net/<iface>/` : operstate·carrier·speed·duplex·mtu·carrier_changes·statistics/*, 본딩은 `bonding/*`
//! - `/proc/net/bonding/<bond>` : 하위 인터페이스별 MII 상태·Aggregator ID·LACP 상대(partner) MAC·링크 실패 횟수
//! - ethtool ioctl(`SIOCETHTOOL`)의 조회(GET) 명령 : ring(-g)·드라이버(-i)·offload(-k)·드라이버 통계(-S)·autoneg.
//!   커널이 GET 명령은 권한 없이 허용하므로 ethtool 바이너리도 capability 도 필요 없다.
//!
//! 어떤 오류도 보고 전체를 막지 않는다 — 인터페이스·항목 단위로 비우고 `errors` 에 남긴다.
//! 보고 JSON 의 키·단위는 서버 `services/nic_watch/analyze.py` 가 읽는 계약이다(바꾸지 않는다).
use serde_json::{json, Map, Value};
use std::fs;
use std::path::{Path, PathBuf};

const SIOCETHTOOL: u32 = 0x8946;
const ETHTOOL_GSET: u32 = 0x01;
const ETHTOOL_GDRVINFO: u32 = 0x03;
const ETHTOOL_GRINGPARAM: u32 = 0x10;
const ETHTOOL_GRXCSUM: u32 = 0x14;
const ETHTOOL_GTXCSUM: u32 = 0x16;
const ETHTOOL_GSG: u32 = 0x18;
const ETHTOOL_GSTRINGS: u32 = 0x1B;
const ETHTOOL_GSTATS: u32 = 0x1D;
const ETHTOOL_GTSO: u32 = 0x1E;
const ETHTOOL_GGSO: u32 = 0x23;
const ETHTOOL_GFLAGS: u32 = 0x25;
const ETHTOOL_GGRO: u32 = 0x2B;
const ETHTOOL_GSSET_INFO: u32 = 0x37;
const ETHTOOL_GFEATURES: u32 = 0x3A;
const ETH_SS_STATS: u32 = 1;
const ETH_SS_FEATURES: u32 = 4;
const ETH_FLAG_LRO: u32 = 1 << 15;
const ETH_GSTRING_LEN: usize = 32;

const MAX_IFACES: usize = 64;
const MAX_DRIVER_STATS: usize = 40;

/// 보고하는 offload(커널 기능 이름). 화면 이름(ethtool -k)은 백엔드가 붙인다.
const FEATURES: [&str; 16] = [
    "rx-checksum",
    "tx-checksum-ip-generic",
    "tx-checksum-ipv4",
    "tx-checksum-ipv6",
    "tx-scatter-gather",
    "tx-tcp-segmentation",
    "tx-tcp6-segmentation",
    "tx-generic-segmentation",
    "rx-gro",
    "rx-gro-hw",
    "rx-lro",
    "tx-udp_tnl-segmentation",
    "tx-udp_tnl-csum-segmentation",
    "rx-hashing",
    "rx-vlan-hw-parse",
    "tx-vlan-hw-insert",
];

/// /sys/class/net/<iface>/statistics 에서 읽는 카운터 — 드롭·오류 판단용.
const SYSFS_COUNTERS: [&str; 12] = [
    "rx_packets",
    "tx_packets",
    "rx_dropped",
    "tx_dropped",
    "rx_errors",
    "tx_errors",
    "rx_missed_errors",
    "rx_fifo_errors",
    "rx_over_errors",
    "rx_crc_errors",
    "rx_frame_errors",
    "rx_length_errors",
];

/// 드라이버 통계(ethtool -S) 중 드롭·버퍼 부족·오류로 보이는 것만 보낸다(수백 개라 전부 보내지 않는다).
fn is_interesting_stat(name: &str) -> bool {
    let n = name.to_lowercase();
    [
        "miss",
        "nobuf",
        "no_buf",
        "out_of_buffer",
        "discard",
        "fifo",
        "drop",
        "crc",
        "over",
        "err",
        "alloc_fail",
    ]
    .iter()
    .any(|k| n.contains(k))
}

fn default_config() -> Map<String, Value> {
    let v = json!({
        "enabled": true,
        "include_kinds": ["physical", "bond", "vlan", "tunnel"],
        "include_names": ["cilium_host", "cilium_vxlan", "cilium_geneve"],
        "exclude_names": ["lo", "lxc*", "veth*", "docker*", "cni*", "flannel*", "kube-ipvs*", "nodelocaldns", "tunl*"],
    });
    v.as_object().cloned().unwrap_or_default()
}

// ── sysfs ────────────────────────────────────────────────────────────────────

/// 읽기 실패는 None — 링크 다운 상태의 speed 는 EINVAL.
fn read(p: &Path) -> Option<String> {
    fs::read(p)
        .ok()
        .map(|b| String::from_utf8_lossy(&b).trim().to_string())
}

fn to_int(v: Option<String>) -> Option<i64> {
    v.and_then(|s| s.trim().parse::<i64>().ok())
}

fn opt_int(v: Option<i64>) -> Value {
    v.map_or(Value::Null, |n| json!(n))
}

fn opt_str(v: Option<String>) -> Value {
    v.map_or(Value::Null, Value::String)
}

fn uevent(d: &Path) -> Map<String, Value> {
    let mut out = Map::new();
    for line in read(&d.join("uevent")).unwrap_or_default().lines() {
        if let Some((k, v)) = line.split_once('=') {
            out.insert(k.trim().to_string(), Value::String(v.trim().to_string()));
        }
    }
    out
}

/// physical | bond | vlan | bridge | tunnel | virtual
pub fn iface_kind(d: &Path) -> &'static str {
    if d.join("bonding").is_dir() {
        return "bond";
    }
    if d.join("bridge").is_dir() {
        return "bridge";
    }
    let devtype = uevent(d)
        .get("DEVTYPE")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();
    if devtype == "vlan" {
        return "vlan";
    }
    if ["vxlan", "geneve", "ipip", "gre", "ip6tnl"].contains(&devtype.as_str()) {
        return "tunnel";
    }
    if d.join("device").exists() {
        return "physical";
    }
    "virtual"
}

fn fnmatch(pat: &str, name: &str) -> bool {
    glob::Pattern::new(pat)
        .map(|p| p.matches(name))
        .unwrap_or(false)
}

fn str_list(cfg: &Map<String, Value>, key: &str) -> Vec<String> {
    cfg.get(key)
        .and_then(|v| v.as_array())
        .map(|a| {
            a.iter()
                .map(|x| {
                    x.as_str()
                        .map(String::from)
                        .unwrap_or_else(|| x.to_string())
                })
                .collect()
        })
        .unwrap_or_default()
}

/// 보고할 (이름, 종류). 제외 패턴이 이기고, 종류가 목록에 있거나 이름이 포함 패턴에 맞으면 넣는다.
pub fn select_ifaces(sys_net: &Path, cfg: &Map<String, Value>) -> Vec<(String, &'static str)> {
    let kinds = str_list(cfg, "include_kinds");
    let inc = str_list(cfg, "include_names");
    let exc = str_list(cfg, "exclude_names");
    let mut out = Vec::new();
    let Ok(rd) = fs::read_dir(sys_net) else {
        return out;
    };
    let mut names: Vec<String> = rd
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .collect();
    names.sort();
    for name in names {
        if exc.iter().any(|p| fnmatch(p, &name)) {
            continue;
        }
        let kind = iface_kind(&sys_net.join(&name));
        if kinds.iter().any(|k| k == kind) || inc.iter().any(|p| fnmatch(p, &name)) {
            out.push((name, kind));
        }
        if out.len() >= MAX_IFACES {
            break;
        }
    }
    out
}

fn links(d: &Path, prefix: &str) -> Vec<String> {
    let Ok(rd) = fs::read_dir(d) else {
        return Vec::new();
    };
    let mut v: Vec<String> = rd
        .filter_map(|e| e.ok().map(|e| e.file_name().to_string_lossy().into_owned()))
        .filter_map(|n| n.strip_prefix(prefix).map(String::from))
        .collect();
    v.sort();
    v
}

fn master(d: &Path) -> Option<String> {
    fs::read_link(d.join("master"))
        .ok()
        .and_then(|p| p.file_name().map(|n| n.to_string_lossy().into_owned()))
}

fn read_bond_sysfs(d: &Path) -> Map<String, Value> {
    let b = d.join("bonding");
    let first = |name: &str| {
        read(&b.join(name)).and_then(|v| v.split_whitespace().next().map(String::from))
    };
    let mut m = Map::new();
    m.insert("mode".into(), opt_str(first("mode")));
    m.insert(
        "xmit_hash_policy".into(),
        opt_str(first("xmit_hash_policy")),
    );
    m.insert("lacp_rate".into(), opt_str(first("lacp_rate")));
    for k in ["miimon", "arp_interval", "updelay", "downdelay"] {
        m.insert(k.into(), opt_int(to_int(read(&b.join(k)))));
    }
    let slaves: Vec<Value> = read(&b.join("slaves"))
        .unwrap_or_default()
        .split_whitespace()
        .map(|s| json!(s))
        .collect();
    m.insert("slaves".into(), Value::Array(slaves));
    m
}

/// `/proc/net/bonding/<bond>` 해석 — `{active: {aggregator_id, ports, partner_mac, actor_key, partner_key},
/// slave_state: {이름: {mii_status, speed, duplex, link_failures, aggregator_id, partner_mac, partner_key}}}`.
pub fn parse_proc_bonding(text: &str) -> Value {
    let mut active = Map::new();
    let mut slaves: Map<String, Value> = Map::new();
    let mut cur: Option<String> = None; // None = 본딩 전체 구역
    let mut block = "";
    for raw in text.lines() {
        let line = raw.trim();
        if line.is_empty() {
            continue;
        }
        let low = line.to_lowercase();
        if low.starts_with("slave interface:") {
            let name = line
                .split_once(':')
                .map(|x| x.1.trim())
                .unwrap_or("")
                .to_string();
            slaves
                .entry(name.clone())
                .or_insert_with(|| Value::Object(Map::new()));
            cur = Some(name);
            block = "";
            continue;
        }
        if low.starts_with("active aggregator info") {
            block = "active";
            continue;
        }
        if low.starts_with("details actor lacp pdu") {
            block = "actor";
            continue;
        }
        if low.starts_with("details partner lacp pdu") {
            block = "partner";
            continue;
        }
        let Some((k, v)) = line.split_once(':') else {
            continue;
        };
        let (key, val) = (k.trim().to_lowercase(), v.trim());
        let int = |s: &str| to_int(Some(s.to_string()));
        match &cur {
            None => {
                if block == "active" {
                    match key.as_str() {
                        "aggregator id" => {
                            active.insert("aggregator_id".into(), opt_int(int(val)));
                        }
                        "number of ports" => {
                            active.insert("ports".into(), opt_int(int(val)));
                        }
                        "actor key" => {
                            active.insert("actor_key".into(), opt_int(int(val)));
                        }
                        "partner key" => {
                            active.insert("partner_key".into(), opt_int(int(val)));
                        }
                        "partner mac address" => {
                            active.insert("partner_mac".into(), json!(val.to_lowercase()));
                        }
                        _ => {}
                    }
                }
            }
            Some(name) => {
                let Some(slave) = slaves.get_mut(name).and_then(|s| s.as_object_mut()) else {
                    continue;
                };
                if block == "partner" {
                    match key.as_str() {
                        "system mac address" => {
                            slave.insert("partner_mac".into(), json!(val.to_lowercase()));
                        }
                        "oper key" => {
                            slave.insert("partner_key".into(), opt_int(int(val)));
                        }
                        _ => {}
                    }
                    continue;
                }
                if block == "actor" {
                    continue;
                }
                match key.as_str() {
                    "mii status" => {
                        slave.insert("mii_status".into(), json!(val.to_lowercase()));
                    }
                    "speed" => {
                        let tok = val.split_whitespace().next().unwrap_or("");
                        let speed = if !tok.is_empty() && tok.chars().all(|c| c.is_ascii_digit()) {
                            int(tok)
                        } else {
                            None
                        };
                        slave.insert("speed".into(), opt_int(speed));
                    }
                    "duplex" => {
                        slave.insert("duplex".into(), json!(val.to_lowercase()));
                    }
                    "link failure count" => {
                        slave.insert("link_failures".into(), opt_int(int(val)));
                    }
                    "aggregator id" => {
                        slave.insert("aggregator_id".into(), opt_int(int(val)));
                    }
                    _ => {}
                }
            }
        }
    }
    json!({"active": active, "slave_state": slaves})
}

// ── ethtool ioctl ────────────────────────────────────────────────────────────

fn put32(b: &mut [u8], off: usize, v: u32) {
    b[off..off + 4].copy_from_slice(&v.to_ne_bytes());
}

fn get32(b: &[u8], off: usize) -> u32 {
    u32::from_ne_bytes(b[off..off + 4].try_into().unwrap_or([0; 4]))
}

fn get64(b: &[u8], off: usize) -> u64 {
    u64::from_ne_bytes(b[off..off + 8].try_into().unwrap_or([0; 8]))
}

fn cstr(b: &[u8]) -> String {
    let end = b.iter().position(|c| *c == 0).unwrap_or(b.len());
    String::from_utf8_lossy(&b[..end]).into_owned()
}

#[repr(C)]
struct Ifreq {
    name: [u8; 16],
    data: *mut libc::c_void,
    pad: [u8; 16], // 커널은 sizeof(struct ifreq)=40 바이트를 복사한다
}

/// 한 번 연 소켓으로 인터페이스마다 GET ioctl 을 보낸다. 실패하면 None(드라이버 미지원·가상 인터페이스).
struct Ethtool {
    fd: libc::c_int,
}

impl Ethtool {
    fn open() -> Result<Self, String> {
        // SAFETY: 인자는 상수이고 반환값을 검사한다.
        let fd = unsafe { libc::socket(libc::AF_INET, libc::SOCK_DGRAM, 0) };
        if fd < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(Ethtool { fd })
    }

    fn call(&self, ifname: &str, buf: &mut [u8]) -> bool {
        let mut ifr = Ifreq {
            name: [0; 16],
            data: buf.as_mut_ptr().cast(),
            pad: [0; 16],
        };
        let n = ifname.len().min(15);
        ifr.name[..n].copy_from_slice(&ifname.as_bytes()[..n]);
        // SAFETY: `ifr` 는 유효한 ifreq 레이아웃이고 data 는 호출 동안 살아 있는 buf 를 가리킨다.
        unsafe { libc::ioctl(self.fd, SIOCETHTOOL as _, &mut ifr as *mut Ifreq) == 0 }
    }

    fn value(&self, ifname: &str, cmd: u32) -> Option<u32> {
        let mut b = [0u8; 8];
        put32(&mut b, 0, cmd);
        self.call(ifname, &mut b).then(|| get32(&b, 4))
    }

    fn ring(&self, ifname: &str) -> Option<Value> {
        let mut b = [0u8; 36];
        put32(&mut b, 0, ETHTOOL_GRINGPARAM);
        if !self.call(ifname, &mut b) {
            return None;
        }
        let (rx_max, tx_max, rx, tx) = (get32(&b, 4), get32(&b, 16), get32(&b, 20), get32(&b, 32));
        if rx_max == 0 && tx_max == 0 {
            return None;
        }
        Some(json!({"rx": rx, "rx_max": rx_max, "tx": tx, "tx_max": tx_max}))
    }

    fn drvinfo(&self, ifname: &str) -> Option<Value> {
        let mut b = [0u8; 196];
        put32(&mut b, 0, ETHTOOL_GDRVINFO);
        if !self.call(ifname, &mut b) {
            return None;
        }
        Some(
            json!({"driver": cstr(&b[4..36]), "version": cstr(&b[36..68]), "firmware": cstr(&b[68..100]), "bus": cstr(&b[100..132])}),
        )
    }

    fn autoneg(&self, ifname: &str) -> Option<bool> {
        let mut b = [0u8; 44];
        put32(&mut b, 0, ETHTOOL_GSET);
        self.call(ifname, &mut b).then(|| b[18] != 0)
    }

    fn sset_count(&self, ifname: &str, sset: u32) -> usize {
        let mut b = [0u8; 20];
        put32(&mut b, 0, ETHTOOL_GSSET_INFO);
        b[8..16].copy_from_slice(&(1u64 << sset).to_ne_bytes());
        if !self.call(ifname, &mut b) {
            return 0;
        }
        if get64(&b, 8) & (1u64 << sset) != 0 {
            get32(&b, 16) as usize
        } else {
            0
        }
    }

    fn strings(&self, ifname: &str, sset: u32, n: usize) -> Vec<String> {
        let mut b = vec![0u8; 12 + n * ETH_GSTRING_LEN];
        put32(&mut b, 0, ETHTOOL_GSTRINGS);
        put32(&mut b, 4, sset);
        put32(&mut b, 8, n as u32);
        if !self.call(ifname, &mut b) {
            return Vec::new();
        }
        b[12..].chunks(ETH_GSTRING_LEN).map(cstr).collect()
    }

    fn features(&self, ifname: &str) -> Option<Value> {
        let n = self.sset_count(ifname, ETH_SS_FEATURES);
        let names = if n > 0 {
            self.strings(ifname, ETH_SS_FEATURES, n)
        } else {
            Vec::new()
        };
        if !names.is_empty() {
            let blocks = names.len().div_ceil(32);
            let mut b = vec![0u8; 8 + blocks * 16];
            put32(&mut b, 0, ETHTOOL_GFEATURES);
            put32(&mut b, 4, blocks as u32);
            if self.call(ifname, &mut b) {
                let mut out = Map::new();
                for (i, name) in names.iter().enumerate() {
                    if !FEATURES.contains(&name.as_str()) {
                        continue;
                    }
                    let off = 8 + (i / 32) * 16;
                    let (available, active, never) =
                        (get32(&b, off), get32(&b, off + 8), get32(&b, off + 12));
                    let bit = 1u32 << (i % 32);
                    out.insert(name.clone(), json!({"on": active & bit != 0, "fixed": available & bit == 0 || never & bit != 0}));
                }
                return Some(Value::Object(out));
            }
        }
        self.legacy_features(ifname)
    }

    fn legacy_features(&self, ifname: &str) -> Option<Value> {
        let legacy = [
            ("rx-checksum", ETHTOOL_GRXCSUM),
            ("tx-checksum-ip-generic", ETHTOOL_GTXCSUM),
            ("tx-scatter-gather", ETHTOOL_GSG),
            ("tx-tcp-segmentation", ETHTOOL_GTSO),
            ("tx-generic-segmentation", ETHTOOL_GGSO),
            ("rx-gro", ETHTOOL_GGRO),
        ];
        let mut out = Map::new();
        for (name, cmd) in legacy {
            if let Some(v) = self.value(ifname, cmd) {
                out.insert(name.into(), json!({"on": v != 0, "fixed": false}));
            }
        }
        if let Some(flags) = self.value(ifname, ETHTOOL_GFLAGS) {
            out.insert(
                "rx-lro".into(),
                json!({"on": flags & ETH_FLAG_LRO != 0, "fixed": false}),
            );
        }
        if out.is_empty() {
            None
        } else {
            Some(Value::Object(out))
        }
    }

    fn driver_stats(&self, ifname: &str) -> Vec<(String, u64)> {
        let n = self.sset_count(ifname, ETH_SS_STATS);
        if n == 0 || n > 4096 {
            return Vec::new();
        }
        let names = self.strings(ifname, ETH_SS_STATS, n);
        if names.len() != n {
            return Vec::new();
        }
        let mut b = vec![0u8; 8 + n * 8];
        put32(&mut b, 0, ETHTOOL_GSTATS);
        put32(&mut b, 4, n as u32);
        if !self.call(ifname, &mut b) {
            return Vec::new();
        }
        let mut out = Vec::new();
        for (i, name) in names.into_iter().enumerate() {
            if is_interesting_stat(&name) {
                out.push((name, get64(&b, 8 + i * 8)));
                if out.len() >= MAX_DRIVER_STATS {
                    break;
                }
            }
        }
        out
    }
}

impl Drop for Ethtool {
    fn drop(&mut self) {
        // SAFETY: 우리가 연 fd 를 한 번만 닫는다.
        unsafe { libc::close(self.fd) };
    }
}

// ── 수집 ─────────────────────────────────────────────────────────────────────

/// `{interfaces: [...], errors: [...]}` — 응답의 `nic` 설정(`cfg`)대로 인터페이스를 고른다.
pub fn collect(
    cfg: Option<&Map<String, Value>>,
    sys_net: &Path,
    proc_bonding: &Path,
    use_ethtool: bool,
) -> Value {
    let mut merged = default_config();
    if let Some(c) = cfg {
        for (k, v) in c {
            merged.insert(k.clone(), v.clone());
        }
    }
    let mut errors: Vec<String> = Vec::new();
    let eth = if use_ethtool {
        match Ethtool::open() {
            Ok(e) => Some(e),
            Err(e) => {
                errors.push(format!("ethtool 소켓 열기 실패: {e}"));
                None
            }
        }
    } else {
        None
    };
    let mut ifaces: Vec<Map<String, Value>> = Vec::new();
    for (name, kind) in select_ifaces(sys_net, &merged) {
        let d = sys_net.join(&name);
        let mut it = Map::new();
        it.insert("name".into(), json!(name));
        it.insert("kind".into(), json!(kind));
        it.insert("operstate".into(), opt_str(read(&d.join("operstate"))));
        it.insert("carrier".into(), opt_int(to_int(read(&d.join("carrier")))));
        it.insert("mtu".into(), opt_int(to_int(read(&d.join("mtu")))));
        let speed = to_int(read(&d.join("speed"))).filter(|s| *s > 0);
        it.insert("speed".into(), opt_int(speed));
        let duplex = read(&d.join("duplex")).filter(|x| x == "full" || x == "half");
        it.insert("duplex".into(), opt_str(duplex));
        it.insert("master".into(), opt_str(master(&d)));
        it.insert("lowers".into(), json!(links(&d, "lower_")));
        let mut counters = Map::new();
        for c in SYSFS_COUNTERS {
            if let Some(v) = to_int(read(&d.join("statistics").join(c))) {
                counters.insert(c.into(), json!(v));
            }
        }
        if let Some(cc) = to_int(read(&d.join("carrier_changes"))) {
            counters.insert("carrier_changes".into(), json!(cc));
        }
        if kind == "vlan" {
            let id = name
                .rsplit_once('.')
                .and_then(|(_, t)| t.parse::<i64>().ok());
            it.insert("vlan_id".into(), opt_int(id));
        }
        if kind == "bond" {
            let mut bond = read_bond_sysfs(&d);
            if let Some(text) = read(&proc_bonding.join(&name)).filter(|t| !t.is_empty()) {
                if let Value::Object(extra) = parse_proc_bonding(&text) {
                    bond.extend(extra);
                }
            }
            it.insert("bond".into(), Value::Object(bond));
        }
        if let Some(eth) = &eth {
            if ["physical", "bond", "vlan", "tunnel"].contains(&kind) {
                if kind == "physical" {
                    it.insert("ring".into(), eth.ring(&name).unwrap_or(Value::Null));
                    it.insert("driver".into(), eth.drvinfo(&name).unwrap_or(Value::Null));
                    it.insert(
                        "autoneg".into(),
                        eth.autoneg(&name).map_or(Value::Null, Value::Bool),
                    );
                    for (k, v) in eth.driver_stats(&name) {
                        counters.insert(format!("drv:{k}"), json!(v));
                    }
                }
                it.insert(
                    "features".into(),
                    eth.features(&name).unwrap_or(Value::Null),
                );
            }
        }
        it.insert("counters".into(), Value::Object(counters));
        ifaces.push(it);
    }
    // 본딩 하위 인터페이스에 LACP 상태를 붙인다(화면이 인터페이스 행에서 바로 보이게).
    let slave_states: Vec<(String, Value)> = ifaces
        .iter()
        .filter_map(|i| {
            i.get("bond")
                .and_then(|b| b.get("slave_state"))
                .and_then(|s| s.as_object())
        })
        .flat_map(|m| m.iter().map(|(k, v)| (k.clone(), v.clone())))
        .collect();
    for (sname, st) in slave_states {
        if let Some(target) = ifaces
            .iter_mut()
            .find(|i| i.get("name").and_then(|n| n.as_str()) == Some(sname.as_str()))
        {
            if let Some(lf) = st.get("link_failures").filter(|v| !v.is_null()).cloned() {
                if let Some(c) = target.get_mut("counters").and_then(|c| c.as_object_mut()) {
                    c.insert("bond_link_failures".into(), lf);
                }
            }
            target.insert("lacp".into(), st);
        }
    }
    json!({"interfaces": ifaces, "errors": errors})
}

/// 환경 변수(`SYS_CLASS_NET`·`PROC_NET_BONDING`)로 경로를 바꿀 수 있는 실행용 진입점.
pub fn collect_default(cfg: Option<&Map<String, Value>>) -> Value {
    let sys_net =
        PathBuf::from(std::env::var("SYS_CLASS_NET").unwrap_or_else(|_| "/sys/class/net".into()));
    let proc_bonding = PathBuf::from(
        std::env::var("PROC_NET_BONDING").unwrap_or_else(|_| "/proc/net/bonding".into()),
    );
    collect(cfg, &sys_net, &proc_bonding, true)
}

#[cfg(test)]
mod tests {
    use super::*;

    const BOND: &str = "Ethernet Channel Bonding Driver: v5.15\n\nBonding Mode: IEEE 802.3ad Dynamic link aggregation\n\n802.3ad info\nActive Aggregator Info:\n\tAggregator ID: 1\n\tNumber of ports: 2\n\tActor Key: 9\n\tPartner Key: 32768\n\tPartner Mac Address: AA:BB:CC:00:00:01\n\nSlave Interface: eth0\nMII Status: up\nSpeed: 25000 Mbps\nDuplex: full\nLink Failure Count: 2\nAggregator ID: 1\nDetails actor lacp pdu:\n    system mac address: 11:11:11:11:11:11\n    oper key: 9\nDetails partner lacp pdu:\n    system mac address: AA:BB:CC:00:00:01\n    oper key: 32768\n\nSlave Interface: eth1\nMII Status: down\nSpeed: Unknown\nDuplex: Unknown\nLink Failure Count: 0\nAggregator ID: 2\n";

    #[test]
    fn parses_proc_bonding_lacp() {
        let v = parse_proc_bonding(BOND);
        assert_eq!(v["active"]["aggregator_id"], 1);
        assert_eq!(v["active"]["partner_mac"], "aa:bb:cc:00:00:01");
        assert_eq!(v["slave_state"]["eth0"]["mii_status"], "up");
        assert_eq!(v["slave_state"]["eth0"]["speed"], 25000);
        assert_eq!(v["slave_state"]["eth0"]["partner_mac"], "aa:bb:cc:00:00:01");
        assert_eq!(v["slave_state"]["eth0"]["link_failures"], 2);
        assert!(v["slave_state"]["eth1"]["speed"].is_null());
        assert_eq!(v["slave_state"]["eth1"]["aggregator_id"], 2);
    }

    fn fake_sys(tag: &str) -> (PathBuf, PathBuf) {
        // 테스트는 병렬로 돈다 — 같은 디렉터리를 공유하면 한쪽의 정리가 다른 쪽 픽스처를 지운다.
        let root = std::env::temp_dir().join(format!("pep-agent-nic-{tag}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let net = root.join("net");
        for n in ["eth0", "eth1", "bond0", "lo", "veth12", "bond0.100"] {
            fs::create_dir_all(net.join(n).join("statistics")).unwrap();
        }
        for n in ["eth0", "eth1"] {
            fs::create_dir_all(net.join(n).join("device")).unwrap();
            fs::write(net.join(n).join("operstate"), "up\n").unwrap();
            fs::write(net.join(n).join("speed"), "25000\n").unwrap();
            fs::write(net.join(n).join("duplex"), "full\n").unwrap();
            fs::write(net.join(n).join("mtu"), "9000\n").unwrap();
            fs::write(net.join(n).join("statistics/rx_dropped"), "7\n").unwrap();
            fs::write(net.join(n).join("carrier_changes"), "3\n").unwrap();
        }
        fs::create_dir_all(net.join("bond0/bonding")).unwrap();
        fs::write(net.join("bond0/bonding/mode"), "802.3ad 4\n").unwrap();
        fs::write(net.join("bond0/bonding/slaves"), "eth0 eth1\n").unwrap();
        fs::write(net.join("bond0/bonding/miimon"), "100\n").unwrap();
        fs::write(net.join("bond0.100/uevent"), "DEVTYPE=vlan\n").unwrap();
        let bonding = root.join("bonding");
        fs::create_dir_all(&bonding).unwrap();
        fs::write(bonding.join("bond0"), BOND).unwrap();
        (net, bonding)
    }

    #[test]
    fn selects_by_kind_and_exclusion() {
        let (net, _) = fake_sys("select");
        let got = select_ifaces(&net, &default_config());
        let names: Vec<&str> = got.iter().map(|(n, _)| n.as_str()).collect();
        assert_eq!(names, ["bond0", "bond0.100", "eth0", "eth1"]); // lo·veth* 제외
        assert_eq!(got[1].1, "vlan");
    }

    #[test]
    fn collect_without_ethtool_reports_bond_lacp_and_counters() {
        let (net, bonding) = fake_sys("collect");
        let out = collect(None, &net, &bonding, false);
        let ifs = out["interfaces"].as_array().unwrap();
        let by = |n: &str| ifs.iter().find(|i| i["name"] == n).unwrap();
        assert_eq!(by("bond0")["bond"]["mode"], "802.3ad");
        assert_eq!(by("bond0")["bond"]["miimon"], 100);
        assert_eq!(by("bond0.100")["vlan_id"], 100);
        let e0 = by("eth0");
        assert_eq!(e0["speed"], 25000);
        assert_eq!(e0["mtu"], 9000);
        assert_eq!(e0["counters"]["rx_dropped"], 7);
        assert_eq!(e0["counters"]["carrier_changes"], 3);
        assert_eq!(e0["lacp"]["mii_status"], "up");
        assert_eq!(e0["counters"]["bond_link_failures"], 2);
        assert!(e0.get("ring").is_none()); // ethtool 끄면 키 자체가 없다
        assert!(out["errors"].as_array().unwrap().is_empty());
    }

    #[test]
    fn interesting_driver_stats() {
        assert!(is_interesting_stat("rx_out_of_buffer"));
        assert!(is_interesting_stat("tx_Discards_phy"));
        assert!(!is_interesting_stat("rx_bytes"));
    }
}
