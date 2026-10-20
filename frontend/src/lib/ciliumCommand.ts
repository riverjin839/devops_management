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
 *  - `-h`/`--help` 가 어디든 있으면 조회(도움말만 출력하고 실행하지 않는다).
 *  - 플래그(`-`로 시작)는 건너뛰고, 값을 받는 출력 플래그(`-o`·`--output`)는 그 값도 건너뛴다.
 *  - 남은 위치 인자의 앞부분이 패턴과 맞으면 조회. `*` 는 아무 토큰 하나(`bpf <맵> list`).
 *  - `config` 는 인자 없이 조회만 — `config Key=Value` 는 설정 변경이라 목록 밖.
 *
 * 판정 예시
 * | 입력                              | 판정 | 이유                            |
 * |-----------------------------------|------|---------------------------------|
 * | `status --verbose`                | 조회 | `status`                        |
 * | `bpf ct list global`              | 조회 | `bpf <맵> list`                 |
 * | `bpf policy get 1234`             | 조회 | `bpf <맵> get`                  |
 * | `endpoint list -o json`           | 조회 | `endpoint list`(-o 값 건너뜀)   |
 * | `-o json service list`            | 조회 | 플래그를 건너뛴 위치 인자 판정  |
 * | `config`                          | 조회 | 인자 없는 config                |
 * | `endpoint delete 12 --help`       | 조회 | 도움말                          |
 * | `config PolicyEnforcement=always` | 위험 | config 쓰기                     |
 * | `bpf ct flush global`             | 위험 | `bpf ct flush` — 목록 밖        |
 * | `endpoint delete 1234`            | 위험 | `endpoint delete` — 목록 밖     |
 * | `cleanup -f`                      | 위험 | `cleanup` — 목록 밖             |
 * | `ipam status`                     | 위험 | 서버 목록에 없음                |
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

/** 값을 받는 출력 플래그 — 값이 위치 인자로 오인되지 않도록 건너뛴다(서버 `_CILIUM_VALUE_FLAGS`). */
const VALUE_FLAGS = new Set(['-o', '--output']);

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

function positional(parts: string[]): string[] {
  const out: string[] = [];
  let skip = false;
  for (const tok of parts) {
    if (skip) { skip = false; continue; }
    if (tok.startsWith('-')) {
      if (VALUE_FLAGS.has(tok)) skip = true;
      continue;
    }
    out.push(tok);
  }
  return out;
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

  if (parts.some((t) => t === '-h' || t === '--help')) {
    return { args, readOnly: true, subcommand: 'help' };
  }
  const pos = positional(parts);
  const subcommand = (pos.length ? pos.slice(0, 3) : parts.slice(0, 2)).join(' ');
  if (pos.length === 0) {
    return { args, readOnly: false, subcommand, reason: `하위 명령이 없습니다 — ${subcommand}` };
  }
  for (const rule of rules) {
    if (pos.length < rule.length) continue;
    if (rule.every((r, i) => r === '*' || r === pos[i])) {
      if (rule.length === 1 && rule[0] === 'config' && pos.length > 1) {
        return { args, readOnly: false, subcommand, reason: `설정 변경 명령 — ${subcommand}` };
      }
      return { args, readOnly: true, subcommand };
    }
  }
  return { args, readOnly: false, subcommand, reason: `쓰기·삭제 가능 명령 — ${subcommand}` };
}
