/**
 * Cilium 직접 명령(`cilium-dbg <args>`) 위험 판정 — D-171 ④ (13차 정책 1·2).
 *
 * 판정은 **읽기 전용 allowlist** 다. 아래 패턴으로 시작하는 명령만 "조회"로 보고, 그 밖은 전부 쓰기·삭제
 * 가능 명령으로 본다 → 화면은 danger 확인창을 거치고, 서버는 admin 이 아니면 403 으로 거부한다.
 *
 * **서버 원천**: `backend/app/services/cilium_trace_service.py` 의 `CILIUM_READONLY_COMMANDS` ·
 * `is_cilium_readonly_command`. 이 파일은 그 규칙을 그대로 옮긴 것이다 — 한쪽만 고치면 화면은 실행
 * 가능하다고 안내하는데 서버가 막는다(또는 반대). 목록을 바꿀 때는 두 곳을 같은 커밋에서 고친다.
 * (화면 안내 문구의 목록은 `GET /cilium/{id}/exec-command/allowlist` 응답을 우선 쓴다.)
 *
 * 규칙(서버와 동일)
 *  - 앞의 `cilium-dbg`/`cilium` 접두는 떼고 본다. 따옴표가 짝이 맞지 않으면(파싱 불가) 목록 밖.
 *  - `--config`·`-H`·`--host`(`=값`·붙여 쓴 꼴 포함)는 어디에 있든 목록 밖(다른 agent·설정 파일 전환).
 *  - 명령은 하위 명령 단어로 **시작**해야 한다 — `parts[:rule.length]` 가 규칙과 정확히 같아야 하고
 *    앞쪽 플래그는 불가(cobra 가 플래그를 건너뛰고 하위 명령을 찾아 `--x status endpoint delete` 우회가 된다).
 *    `*` 는 아무 토큰 하나(`bpf <맵> list`)지만 `-` 로 시작하는 토큰은 안 된다.
 *  - 규칙 뒤에는 위치 인자와 읽기 전용 플래그만: `-o`/`--output <값>`(`--output=값`), `-n <값>`,
 *    `-v`/`--verbose`, `status` 의 `--all-*` 조회 플래그, `-h`/`--help`(이미 허용된 명령 뒤에서만).
 *  - `config` 는 위치 인자 없이 조회만 — `config Key=Value` 는 설정 변경이라 목록 밖.
 *  - `debuginfo` 의 `-f`/`--file`/`--file-per-command` 는 agent 에 파일을 쓰므로 목록 밖.
 *
 * 판정 예시
 * | 입력                              | 판정 | 이유                              |
 * |-----------------------------------|------|-----------------------------------|
 * | `status --verbose`                | 조회 | `status`                          |
 * | `status -h`                       | 조회 | 허용 명령 뒤 도움말               |
 * | `bpf ct list global`              | 조회 | `bpf <맵> list`                   |
 * | `bpf policy get 1234`             | 조회 | `bpf <맵> get`                    |
 * | `endpoint list -o json`           | 조회 | `endpoint list` + 출력 플래그     |
 * | `config`                          | 조회 | 인자 없는 config                  |
 * | `-o json service list`            | 위험 | 하위 명령 앞 플래그               |
 * | `--config x status endpoint delete 1` | 위험 | `--config`                    |
 * | `endpoint delete 12 --help`       | 위험 | `endpoint delete` — 목록 밖       |
 * | `--host=unix:///x status`         | 위험 | `--host`                          |
 * | `debuginfo -f /tmp/x`             | 위험 | debuginfo 파일 쓰기               |
 * | `config PolicyEnforcement=always` | 위험 | config 쓰기                       |
 * | `bpf ct flush global`             | 위험 | `bpf ct flush` — 목록 밖          |
 * | `cleanup -f`                      | 위험 | `cleanup` — 목록 밖               |
 * | `ipam status`                     | 위험 | 서버 목록에 없음                  |
 */

/** 읽기 전용 하위 명령 패턴. `*` 는 아무 토큰 한 개. 서버 `CILIUM_READONLY_COMMANDS` 와 동일하게 유지한다. */
export const CILIUM_READONLY_COMMANDS: readonly (readonly string[])[] = [
  ['status'],
  ['version'],
  ['debuginfo'],
  ['config'], // 인자 없이 조회만 — classify 에서 `config Key=Value` 를 따로 막는다
  ['endpoint', 'list'], ['endpoint', 'get'], ['endpoint', 'log'], ['endpoint', 'health'],
  ['identity', 'list'], ['identity', 'get'],
  ['service', 'list'], ['service', 'get'],
  ['policy', 'get'], ['policy', 'selectors'],
  ['ip', 'list'], ['ip', 'get'],
  ['node', 'list'], ['nodeid', 'list'],
  ['map', 'list'], ['map', 'get'],
  ['metrics', 'list'],
  ['fqdn', 'cache', 'list'],
  ['lrp', 'list'],
  ['encrypt', 'status'],
  ['kvstore', 'get'],
  ['bgp', 'peers'], ['bgp', 'routes'], ['bgp', 'route-policies'],
  ['prefilter', 'list'],
  ['recorder', 'list'],
  ['cgroups', 'list'],
  ['bpf', '*', 'list'], ['bpf', '*', 'get'], ['bpf', 'fs', 'show'],
  ['help'],
];

/** 규칙 뒤 값 받는 플래그 — 다음 토큰을 값으로 소비(서버 `_CILIUM_VALUE_FLAGS`). `--output=값` 꼴도 허용. */
const VALUE_FLAGS = new Set(['-o', '--output', '-n']);
/** 규칙 뒤 값 없는 읽기 전용 플래그(서버 `_CILIUM_BOOL_FLAGS`). */
const BOOL_FLAGS = new Set([
  '-v', '--verbose', '-h', '--help',
  '--all-addresses', '--all-clusters', '--all-controllers', '--all-health',
  '--all-nodes', '--all-redirects',
]);
/** 어디에 있든 목록 밖(서버 `_CILIUM_DENY_LONG` + `-H`). */
const DENY_LONG = ['--config', '--host'];
/** debuginfo 파일 쓰기 플래그(서버 `_CILIUM_DEBUGINFO_FILE_LONG` + `-f`). */
const DEBUGINFO_FILE_LONG = ['--file', '--file-per-command'];

/** 화면 안내용 목록 — 서버 `cilium_readonly_command_labels()` 와 같은 표기(`bpf <맵> list`). */
export const CILIUM_READONLY_LABELS: readonly string[] = CILIUM_READONLY_COMMANDS.map(
  (rule) => rule.map((t) => (t === '*' ? '<맵>' : t)).join(' '),
);

/**
 * 서버 allowlist 응답(`commands: ["bpf <맵> list", …]`)을 판정 규칙으로 되돌린다.
 * 화면은 이 결과를 우선 쓰고, 조회 실패·빈 응답이면 로컬 목록(`CILIUM_READONLY_COMMANDS`)으로 폴백한다.
 */
export function ciliumRulesFromLabels(labels: readonly string[] | undefined | null): readonly (readonly string[])[] {
  const rules = (labels ?? [])
    .map((l) => l.trim().split(/\s+/).filter(Boolean).map((t) => (/^<.*>$/.test(t) ? '*' : t)))
    .filter((r) => r.length > 0);
  return rules.length > 0 ? rules : CILIUM_READONLY_COMMANDS;
}

export interface CiliumCommandVerdict {
  /** 앞의 `cilium-dbg` 를 뗀 인자(공백 정리). 비어 있으면 실행 불가. */
  args: string;
  /** allowlist 와 일치하면 true. */
  readOnly: boolean;
  /** 판정에 쓴 하위 명령(위치 인자 최대 3개) — 확인창·안내 문구용. */
  subcommand: string;
  /** 목록 밖일 때 사유 1줄 — "쓰기·삭제 가능 명령 — {하위 명령}". */
  reason?: string;
}

/** Python `shlex.split` 의 POSIX 기본 동작(따옴표·백슬래시) 축약판. 따옴표가 짝이 안 맞으면 null. */
function shlexSplit(input: string): string[] | null {
  const out: string[] = [];
  let cur = '';
  let inToken = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i];
    if (quote === "'") {
      if (ch === "'") quote = null; else cur += ch;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === '\\' && i + 1 < input.length && '"\\$`\n'.includes(input[i + 1])) cur += input[++i];
      else cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inToken) { out.push(cur); cur = ''; inToken = false; }
      continue;
    }
    inToken = true;
    if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') { if (i + 1 < input.length) cur += input[++i]; else return null; }
    else cur += ch;
  }
  if (quote) return null;
  if (inToken) out.push(cur);
  return out;
}

function longFlagIs(tok: string, names: readonly string[]): boolean {
  return names.some((n) => tok === n || tok.startsWith(`${n}=`));
}

function deniedToken(tok: string): boolean {
  return longFlagIs(tok, DENY_LONG) || (tok.startsWith('-H') && !tok.startsWith('--'));
}

function debuginfoWritesFile(tok: string): boolean {
  return longFlagIs(tok, DEBUGINFO_FILE_LONG) || (tok.startsWith('-f') && !tok.startsWith('--'));
}

function ruleMatches(rule: readonly string[], parts: string[]): boolean {
  if (parts.length < rule.length) return false;
  return rule.every((r, i) => !parts[i].startsWith('-') && (r === '*' || r === parts[i]));
}

const isRule = (rule: readonly string[], name: string) => rule.length === 1 && rule[0] === name;

/** 규칙 뒤 토큰 검사 — 통과면 null, 아니면 사유(서버 `_cilium_tail_is_readonly`). */
function tailProblem(rule: readonly string[], tail: string[]): string | null {
  for (let i = 0; i < tail.length; i++) {
    const tok = tail[i];
    if (!tok.startsWith('-')) {
      if (isRule(rule, 'config')) return '설정 변경 명령';
      continue;
    }
    if (isRule(rule, 'debuginfo') && debuginfoWritesFile(tok)) return 'agent 에 파일을 쓰는 debuginfo';
    if (BOOL_FLAGS.has(tok)) continue;
    if (VALUE_FLAGS.has(tok)) {
      if (i + 1 >= tail.length || tail[i + 1].startsWith('-')) return `값이 없는 플래그 ${tok}`;
      i++;
      continue;
    }
    if (tok.startsWith('--output=')) continue;
    return `허용되지 않은 플래그 ${tok}`;
  }
  return null;
}

export function classifyCiliumCommand(
  input: string,
  rules: readonly (readonly string[])[] = CILIUM_READONLY_COMMANDS,
): CiliumCommandVerdict {
  const trimmed = input.trim();
  const split = shlexSplit(trimmed);
  if (split === null) {
    return { args: trimmed, readOnly: false, subcommand: trimmed.split(/\s+/).slice(0, 3).join(' '), reason: '명령을 해석할 수 없습니다 — 따옴표 짝을 확인하세요' };
  }
  let parts = split;
  if (parts[0] === 'cilium-dbg' || parts[0] === 'cilium') parts = parts.slice(1);
  // 서버로는 사용자가 입력한 원문(접두 제외)을 보낸다 — 판정은 서버가 다시 한다.
  const args = trimmed.replace(/^(cilium-dbg|cilium)(\s+|$)/, '').trim();
  if (parts.length === 0) return { args: '', readOnly: false, subcommand: '' };

  const leadEnd = parts.findIndex((t) => t.startsWith('-'));
  const lead = (leadEnd === -1 ? parts : parts.slice(0, leadEnd)).slice(0, 3);
  const subcommand = (lead.length ? lead : parts.slice(0, 2)).join(' ');
  const denied = parts.find(deniedToken);
  if (denied) {
    return { args, readOnly: false, subcommand, reason: `다른 agent·설정 파일로 전환하는 플래그 — ${denied}` };
  }
  if (parts[0].startsWith('-')) {
    return { args, readOnly: false, subcommand, reason: `하위 명령으로 시작해야 합니다 — ${parts[0]}` };
  }
  for (const rule of rules) {
    if (!ruleMatches(rule, parts)) continue;
    const problem = tailProblem(rule, parts.slice(rule.length));
    if (problem) return { args, readOnly: false, subcommand, reason: `${problem} — ${subcommand}` };
    return { args, readOnly: true, subcommand };
  }
  return { args, readOnly: false, subcommand, reason: `쓰기·삭제 가능 명령 — ${subcommand}` };
}
