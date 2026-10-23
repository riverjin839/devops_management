// 위험 명령 판정(D-171) — **읽기 전용 allowlist 반전**.
//
// 예전에는 "위험해 보이는 키워드"(defrag·rm …)만 골라 danger 확인을 붙였기 때문에 목록에 없는
// 파괴 명령(`del /registry --prefix`·`mc mv`·`sysctl -w`)이 일반 톤 확인을 지나갔다. 이제는 반대로
// **조회로 확인된 하위 명령만 일반 확인**, 그 밖의 모든 명령은 `ConfirmDialog danger` + 사유 1줄
// ("쓰기·삭제 가능 명령 — {하위 명령}")을 거친다. 판정은 화면 확인용이며 서버는 감사로 남긴다
// (etcdctl·mc 는 서버 강제 없음 — 정책 2).
//
// 판정이 애매하면 항상 danger 쪽으로 떨어진다(모르는 앞 플래그·셸 연결·리다이렉트·명령 치환).
//
// ── 판정 예시 ────────────────────────────────────────────────────────────────────────────────
// | 화면    | 명령                                              | 판정  | 하위 명령          |
// |---------|---------------------------------------------------|-------|--------------------|
// | etcdctl | `endpoint health --write-out=table`               | 조회  | endpoint health    |
// | etcdctl | `--endpoints=https://a:2379 member list -w table` | 조회  | member list        |
// | etcdctl | `get /registry/pods --prefix --keys-only`         | 조회  | get                |
// | etcdctl | `del /registry/pods --prefix`                     | 위험  | del                |
// | etcdctl | `defrag --cluster` · `snapshot save /tmp/x.db`    | 위험  | defrag · snapshot save |
// | etcdctl | `get / --prefix | head`                           | 위험  | 셸 연결·리다이렉트 |
// | mc      | `admin info local` · `ls local/bucket`            | 조회  | admin info · ls    |
// | mc      | `admin user list local` · `alias list`            | 조회  | admin user list · alias list |
// | mc      | `admin heal local --dry-run`                      | 조회  | admin heal --dry-run |
// | mc      | `mv a b` · `anonymous set public local/b`         | 위험  | mv · anonymous set |
// | mc      | `admin update local` · `alias set …`              | 위험  | admin update · alias set |
// | shell   | `sysctl net.ipv4.ip_forward` · `cat /proc/meminfo | head` | 조회 | sysctl · cat |
// | shell   | `sysctl -w vm.swappiness=10` · `modprobe -r br_netfilter` | 위험 | sysctl -w · modprobe |
// | shell   | `echo 1 > /proc/sys/net/ipv4/ip_forward`          | 위험  | 리다이렉트(>)      |
// | shell   | `reboot` · `rm -rf /tmp/x` · `for f in …; do …`   | 위험  | reboot · rm · for  |

export type CommandScreen = 'etcdctl' | 'mc' | 'shell';

export interface CommandVerdict {
  /** allowlist 의 조회 명령이면 true — 일반 확인. false 면 danger 확인. */
  readOnly: boolean;
  /** 판정 근거가 된 하위 명령(표시용, 예: "member list"). */
  subcommand: string;
  /** danger 일 때 확인창에 보여줄 사유 1줄. 조회면 null. */
  reason: string | null;
}

// ── etcdctl ─────────────────────────────────────────────────────────────────────────────────

/** etcdctl 조회 하위 명령(앞 위치 인자 기준). `check perf` 는 부하 측정용 키를 실제로 쓰고 지우므로 목록에 두지 않는다(위험 확인). */
export const ETCDCTL_READ_ONLY: readonly string[] = [
  'get',
  'endpoint health',
  'endpoint status',
  'endpoint hashkv',
  'member list',
  'alarm list',
  'version',
  'user list',
  'user get',
  'role list',
  'role get',
  'auth status',
  'lease list',
  'lease timetolive',
];

/** 값을 다음 토큰으로 받는 etcdctl 전역·하위 플래그 — 위치 인자 판정에서 값까지 건너뛴다. */
const ETCDCTL_VALUE_FLAGS = new Set([
  '-w', '--write-out', '--endpoints', '--user', '--password', '--cacert', '--cert', '--key',
  '--dial-timeout', '--command-timeout', '--keepalive-time', '--keepalive-timeout',
  '--discovery-srv', '--discovery-srv-name', '--limit', '--rev', '--sort-by', '--order',
  '--consistency', '--load', '--auth-jwt-token',
]);

/** 두 단어 하위 명령을 갖는 etcdctl 그룹 — 위험 사유 표시용. */
const ETCDCTL_GROUPS = new Set(['endpoint', 'member', 'alarm', 'snapshot', 'lease', 'user', 'role', 'auth', 'check', 'downgrade']);

// ── mc ──────────────────────────────────────────────────────────────────────────────────────

/** mc 조회 최상위 명령(첫 위치 인자). `find` 는 `--exec` 가 없을 때만, `cat`·`head` 는 소용량 조회 가정. */
export const MC_READ_ONLY_TOP: readonly string[] = [
  'ls', 'stat', 'cat', 'head', 'du', 'tree', 'find', 'diff', 'ping', 'ready',
];

/** mc 그룹 명령 중 조회로 보는 조합(그룹 + 동사). `admin info` 와 `--version` 은 별도. */
export const MC_READ_ONLY_GROUP: readonly string[] = [
  'admin info',
  'admin user list', 'admin user ls', 'admin user info',
  'admin user svcacct list', 'admin user svcacct ls', 'admin user svcacct info',
  'admin group list', 'admin group ls', 'admin group info',
  'admin policy list', 'admin policy ls', 'admin policy info', 'admin policy entities',
  'admin config get',
  'admin scanner status', 'admin scanner info',
  'admin replicate info', 'admin replicate status',
  'admin top locks', 'admin top disk', 'admin top api',
  'admin prometheus metrics',
  'admin kms key status', 'admin kms key list',
  'admin bucket remote ls', 'admin bucket remote list',
  'admin tier ls', 'admin tier list', 'admin tier info',
  'alias list', 'alias ls',
  'ilm ls', 'ilm rule ls', 'ilm rule list', 'ilm tier ls', 'ilm tier list', 'ilm tier info',
  'retention info',
  'version info',
  'anonymous get', 'anonymous list', 'anonymous links',
  'quota info',
  'tag list',
  'encrypt info',
  'event ls', 'event list',
  'replicate ls', 'replicate list', 'replicate status',
  'legalhold info',
  'share list',
];

/** 두 단어(admin 은 세 단어) 하위 명령을 갖는 mc 그룹 — 위험 사유 표시용. */
const MC_GROUPS = new Set(['admin', 'alias', 'ilm', 'retention', 'version', 'anonymous', 'quota', 'tag', 'encrypt', 'event', 'replicate', 'legalhold', 'share', 'idp', 'license', 'support', 'batch']);
const MC_ADMIN_GROUPS = new Set(['user', 'group', 'policy', 'config', 'bucket', 'tier', 'replicate', 'kms', 'scanner', 'top', 'service', 'idp', 'cluster', 'decommission']);

// ── 셸(커널 파라미터 직접 입력) ─────────────────────────────────────────────────────────────

/** 셸 조회 명령 — 값은 "금지 인자 판정" 함수(true 면 위험). 목록에 없는 명령은 전부 위험. */
const SHELL_READ_ONLY: Record<string, (args: string[]) => boolean> = {
  sysctl: (a) => a.some((x) => /^(-w|--write|-p|--load|--system|-f)$/.test(x) || /^-[a-zA-Z]*[wpf]/.test(x) || x.includes('=')),
  cat: () => false,
  head: () => false,
  tail: () => false,
  ls: () => false,
  stat: () => false,
  file: () => false,
  readlink: () => false,
  realpath: () => false,
  wc: () => false,
  sort: (a) => a.some((x) => /^(-o|--output)/.test(x)),
  uniq: (a) => a.filter((x) => !x.startsWith('-')).length > 1, // 두 번째 위치 인자 = 출력 파일
  cut: () => false,
  tr: () => false,
  column: () => false,
  grep: () => false,
  egrep: () => false,
  echo: () => false,
  printf: () => false,
  uname: () => false,
  uptime: () => false,
  free: () => false,
  df: () => false,
  du: () => false,
  lsblk: () => false,
  lscpu: () => false,
  lsmod: () => false,
  lspci: () => false,
  lsusb: () => false,
  modinfo: () => false,
  nproc: () => false,
  id: () => false,
  whoami: () => false,
  ps: () => false,
  pidof: () => false,
  vmstat: () => false,
  iostat: () => false,
  mpstat: () => false,
  ss: (a) => a.some((x) => /^(-K|--kill)$/.test(x)),
  netstat: () => false,
  findmnt: () => false,
  mount: (a) => a.some((x) => x !== '-l' && x !== '--show-labels'),
  swapon: (a) => a.length === 0 || a.some((x) => !/^(--show|-s|--summary|--noheadings|--bytes)$/.test(x)),
  ulimit: (a) => a.some((x) => !x.startsWith('-')),
  hostname: (a) => a.some((x) => !x.startsWith('-')),
  date: (a) => a.some((x) => /^(-s|--set)/.test(x)),
  timedatectl: (a) => {
    const p = a.filter((x) => !x.startsWith('-'));
    return p.length > 0 && !['status', 'show', 'timesync-status', 'show-timesync'].includes(p[0]);
  },
  chronyc: (a) => {
    const p = a.filter((x) => !x.startsWith('-'));
    return p.length === 0 || !['tracking', 'sources', 'sourcestats', 'activity', 'ntpdata', 'serverstats'].includes(p[0]);
  },
  ntpstat: () => false,
  ip: (a) => a.some((x) => ['add', 'del', 'delete', 'set', 'flush', 'change', 'replace', 'append', 'prepend', 'exec', 'save', 'restore'].includes(x)),
  ethtool: (a) => a.some((x) => /^-[sKGACLEfWuU]$/.test(x) || /^--(change|set-|reset|flash|test|negotiate|identify)/.test(x)),
  journalctl: (a) => a.some((x) => /^--(vacuum-|rotate|flush|sync|relinquish-var|smart-relinquish-var|setup-keys|update-catalog)/.test(x)),
  dmesg: (a) => a.some((x) => /^(-c|-C|--clear|--read-clear|-n|--console-level|-D|--console-off|-E|--console-on)$/.test(x)),
  systemctl: (a) => {
    const p = a.filter((x) => !x.startsWith('-'));
    return p.length === 0 || !['status', 'show', 'cat', 'is-active', 'is-enabled', 'is-failed', 'list-units', 'list-unit-files', 'list-timers', 'list-dependencies'].includes(p[0]);
  },
  find: (a) => a.some((x) => /^-(delete|exec|execdir|ok|okdir|fprint|fprint0|fprintf|fls)$/.test(x)),
  getenforce: () => false,
  sestatus: () => false,
  getconf: () => false,
  md5sum: () => false,
  sha256sum: () => false,
};

// ── 공통 토크나이저 ─────────────────────────────────────────────────────────────────────────

interface Segment { words: string[] }
interface ShellParse { segments: Segment[]; unsafe: string | null }

/**
 * 따옴표를 존중해 명령을 `|`·`;`·`&&`·`||`·`&`·줄바꿈으로 나누고, 위험 구문을 찾는다.
 * - 명령 치환(`` ` ``·`$(`) → 위험
 * - 리다이렉트 `>`·`>>` 의 대상이 `/dev/null`·`&N` 이 아니면 위험(`2>/dev/null`·`2>&1` 은 허용)
 * - 입력 리다이렉트 `<` 는 읽기라 허용
 */
function parseShell(cmd: string): ShellParse {
  if (/`|\$\(/.test(cmd)) return { segments: [], unsafe: '명령 치환(` 또는 $( ) 포함' };
  const segments: Segment[] = [];
  let words: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  let pendingRedirect = false;
  let unsafe: string | null = null;

  const pushWord = () => {
    if (!has) return;
    if (pendingRedirect) {
      if (!/^(\/dev\/null|&\d+|&-)$/.test(cur)) unsafe = unsafe ?? `리다이렉트(>) — ${cur}`;
      pendingRedirect = false;
    } else {
      words.push(cur);
    }
    cur = '';
    has = false;
  };
  const pushSegment = () => {
    pushWord();
    if (words.length) segments.push({ words });
    words = [];
  };

  for (let i = 0; i < cmd.length; i += 1) {
    const ch = cmd[i];
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < cmd.length) { cur += cmd[i + 1]; has = true; i += 1; continue; }
    if (/\s/.test(ch) && ch !== '\n') { pushWord(); continue; }
    if (ch === '\n' || ch === ';' || ch === '|' || ch === '&') {
      // `2>&1` 의 `&` 는 리다이렉트 대상 — 위 분기에 오기 전에 아래 `>` 처리에서 소비된다.
      pushSegment();
      if ((ch === '|' || ch === '&') && cmd[i + 1] === ch) i += 1;
      continue;
    }
    if (ch === '>') {
      // 숫자 fd 접두(`2>`)는 단어에서 떼어낸다.
      if (has && /^\d+$/.test(cur)) { cur = ''; has = false; } else pushWord();
      if (cmd[i + 1] === '>') i += 1;
      // `>&1` 처럼 붙은 대상
      if (cmd[i + 1] === '&') {
        let j = i + 2;
        let target = '&';
        while (j < cmd.length && /[\d-]/.test(cmd[j])) { target += cmd[j]; j += 1; }
        if (!/^&(\d+|-)$/.test(target)) unsafe = unsafe ?? '리다이렉트(>&)';
        i = j - 1;
        continue;
      }
      pendingRedirect = true;
      continue;
    }
    if (ch === '<') { pushWord(); continue; }
    cur += ch;
    has = true;
  }
  if (quote) unsafe = unsafe ?? '닫히지 않은 따옴표';
  pushSegment();
  if (pendingRedirect) unsafe = unsafe ?? '리다이렉트 대상 없음';
  return { segments, unsafe };
}

const SHELL_CHAIN = /[;&|`<>\n]|\$\(/;

/** 플래그를 빼고 위치 인자만. `valueFlags` 에 든 플래그(`=` 없이)는 다음 토큰까지 건너뛴다. */
function positionals(words: string[], valueFlags: Set<string> = new Set()): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i];
    if (w.startsWith('-')) {
      if (!w.includes('=') && valueFlags.has(w)) i += 1;
      continue;
    }
    out.push(w);
  }
  return out;
}

function verdict(readOnly: boolean, subcommand: string, reason?: string): CommandVerdict {
  return {
    readOnly,
    subcommand,
    reason: readOnly ? null : (reason ?? `쓰기·삭제 가능 명령 — ${subcommand || '(빈 명령)'}`),
  };
}

function words(cmd: string): string[] {
  return cmd.trim().split(/\s+/).filter(Boolean).map((w) => w.replace(/^["']|["']$/g, ''));
}

// ── 화면별 판정 ─────────────────────────────────────────────────────────────────────────────

function judgeEtcdctl(cmd: string): CommandVerdict {
  if (SHELL_CHAIN.test(cmd)) return verdict(false, '셸 연결·리다이렉트', '셸 연결·리다이렉트(; | & > ` $( ) 가 들어 있어 조회로 판정할 수 없습니다');
  let w = words(cmd);
  if (w[0] === 'etcdctl' || w[0]?.endsWith('/etcdctl')) w = w.slice(1);
  const p = positionals(w, ETCDCTL_VALUE_FLAGS);
  const two = p.slice(0, 2).join(' ');
  if (ETCDCTL_READ_ONLY.includes(two)) return verdict(true, two);
  if (p[0] && ETCDCTL_READ_ONLY.includes(p[0])) return verdict(true, p[0]);
  // 사유에 키 경로·값이 섞이지 않게 그룹 명령만 두 단어로 보인다.
  const sub = ETCDCTL_GROUPS.has(p[0] ?? '') ? p.slice(0, 2).join(' ') : (p[0] ?? '');
  return verdict(false, sub);
}

function judgeMc(cmd: string): CommandVerdict {
  if (SHELL_CHAIN.test(cmd)) return verdict(false, '셸 연결·리다이렉트', '셸 연결·리다이렉트(; | & > ` $( ) 가 들어 있어 조회로 판정할 수 없습니다');
  let w = words(cmd);
  if (w[0] === 'mc' || w[0]?.endsWith('/mc')) w = w.slice(1);
  const flags = w.filter((x) => x.startsWith('-'));
  const p = positionals(w);
  if (p.length === 0 && flags.some((x) => x === '--version' || x === '-v')) return verdict(true, '--version');
  const top = p[0] ?? '';
  if (MC_READ_ONLY_TOP.includes(top)) {
    if (top === 'find' && flags.some((x) => x.startsWith('--exec'))) return verdict(false, 'find --exec');
    return verdict(true, top);
  }
  // 그룹 명령 — 앞 2~4 위치 인자 조합 중 가장 긴 일치
  for (const n of [4, 3, 2]) {
    const key = p.slice(0, n).join(' ');
    if (MC_READ_ONLY_GROUP.includes(key)) return verdict(true, key);
  }
  if (top === 'admin' && p[1] === 'heal' && flags.includes('--dry-run')) return verdict(true, 'admin heal --dry-run');
  const n = top === 'admin' ? (MC_ADMIN_GROUPS.has(p[1] ?? '') ? 3 : 2) : MC_GROUPS.has(top) ? 2 : 1;
  return verdict(false, p.slice(0, n).join(' '));
}

function judgeShell(cmd: string): CommandVerdict {
  const { segments, unsafe } = parseShell(cmd);
  if (unsafe) return verdict(false, unsafe, `조회로 판정할 수 없는 구문 — ${unsafe}`);
  if (segments.length === 0) return verdict(false, '', '빈 명령');
  for (const seg of segments) {
    let w = seg.words;
    // `sudo [-flags] cmd …`, `VAR=val cmd …` 접두는 건너뛴다.
    while (w.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w[0]) || w[0] === 'sudo' || (w[0].startsWith('-') && seg.words[0] === 'sudo'))) {
      w = w.slice(1);
    }
    const name = (w[0] ?? '').replace(/^.*\//, '');
    const rule = SHELL_READ_ONLY[name];
    if (!rule) return verdict(false, name);
    const args = w.slice(1);
    if (rule(args)) {
      const flag = args.find((x) => x.startsWith('-')) ?? args[0] ?? '';
      return verdict(false, `${name}${flag ? ` ${flag}` : ''}`);
    }
  }
  const first = segments[0].words.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x) && x !== 'sudo') ?? '';
  return verdict(true, first.replace(/^.*\//, ''));
}

/** 화면별 위험 판정. 빈 명령은 위험(확인창에서 사유 표시). */
export function judgeCommand(cmd: string, screen: CommandScreen): CommandVerdict {
  const c = (cmd ?? '').trim();
  if (!c) return verdict(false, '', '빈 명령');
  if (screen === 'etcdctl') return judgeEtcdctl(c);
  if (screen === 'mc') return judgeMc(c);
  return judgeShell(c);
}

