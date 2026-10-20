// 명령 문자열의 비밀값 마스킹(D-176) — 서버 `backend/app/services/command_mask.py` 와 같은 규칙.
//
// 확인창·결과 패널·실행 로그·저장 명령 표시에 명령 원문을 보여줄 때 반드시 이 함수를 거친다.
// 규칙을 바꾸면 서버 쪽 정규식도 같은 커밋에서 바꾼다(감사 로그와 화면 표시가 어긋나지 않게).
//
// 대소문자 무시. 값 부분만 `****` 로 바꾸고 플래그·변수 이름은 남긴다.
//
// | 입력                                                      | 출력                                              |
// |-----------------------------------------------------------|---------------------------------------------------|
// | `get / --user root:s3cret --prefix`                       | `get / --user root:**** --prefix`                 |
// | `--password=abc member list`                              | `--password=**** member list`                     |
// | `--pass abc` · `--secret-key=abc` · `--token abc`         | `--pass ****` · `--secret-key=****` · `--token ****` |
// | `ETCDCTL_PASSWORD=abc etcdctl get /`                      | `ETCDCTL_PASSWORD=**** etcdctl get /`             |
// | `MINIO_SECRET_KEY="a b" mc ls`                            | `MINIO_SECRET_KEY=**** mc ls`                     |
// | `MC_HOST_x=https://AK:SK@h:9000` · `sshpass -p pw`        | `MC_HOST_x=https://****:****@h:9000` · `sshpass -p ****` |
// | `alias set prod https://s3:9000 AKIA123 wJalr`            | `alias set prod https://s3:9000 **** ****`        |
// | `curl -H "Authorization: Bearer eyJhbGc"`                 | `curl -H "Authorization: Bearer ****"`            |

/** 값 — 따옴표 문자열 또는 공백·따옴표가 아닌 연속 문자(서버 `_VAL` 과 동일). */
const VALUE = String.raw`(?:'[^']*'|"[^"]*"|[^\s'"]+)`;

const MASK = '****';

type Replacer = (match: string, ...groups: string[]) => string;
const keepHead: Replacer = (_m, head) => `${head}${MASK}`;

// 순서대로 적용한다 — 서버 `_RULES` 와 같은 순서·패턴.
const RULES: Array<[RegExp, Replacer]> = [
  // --password / --pass / --secret / --secret-key / --token (= 또는 공백 구분)
  [new RegExp(String.raw`(--(?:password|pass|secret(?:-key)?|token)(?:=|\s+))${VALUE}`, 'gi'), keepHead],
  // --user name:password — 이름은 남기고 비밀번호만(etcdctl `--user u:p`)
  [new RegExp(String.raw`(--user(?:=|\s+)['"]?[^\s:'"]*:)[^\s'"]+`, 'gi'), keepHead],
  // PASSWORD=… / ETCDCTL_PASSWORD=… / MINIO_SECRET_KEY=… / API_KEY=… 같은 환경변수 대입
  [new RegExp(String.raw`((?:PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|SECRET_KEY|API_KEY)[A-Z_]*=)${VALUE}`, 'gi'), keepHead],
  // mc alias set <name> <url> <access> <secret> — access·secret 두 인자
  [new RegExp(String.raw`(\balias\s+set\s+${VALUE}\s+${VALUE}\s+)${VALUE}(\s+)${VALUE}`, 'gi'),
    (_m, head, sep) => `${head}${MASK}${sep}${MASK}`],
  // Authorization: Bearer <token>
  [/(Authorization:\s*Bearer\s+)[^\s'"]+/gi, keepHead],
  // ── 서버 추가 규칙(D-170)도 같이 둔다 — 화면과 감사 로그가 같은 값을 가린다 ──
  // MC_HOST_<alias>=https://ACCESS:SECRET@host
  [/(MC_HOST_\w*=['"]?[a-z][a-z0-9+.-]*:\/\/)[^:@\s'"/]+:[^@\s'"/]+@/gi, (_m, head) => `${head}${MASK}:${MASK}@`],
  // sshpass -p X
  [new RegExp(String.raw`(\bsshpass\s+-p\s*)${VALUE}`, 'gi'), keepHead],
  // scheme://user:password@host (위 규칙이 이미 가린 **** 는 그대로)
  [/([a-z][a-z0-9+.-]*:\/\/[^:@\s'"/]+:)(?!\*\*\*\*@)[^@\s'"/]+@/gi, (_m, head) => `${head}${MASK}@`],
];

/** 명령 문자열의 비밀값을 `****` 로 가린다. 빈 값·null 은 빈 문자열. */
export function maskCommand(cmd: string | null | undefined): string {
  if (!cmd) return '';
  return RULES.reduce((out, [re, fn]) => out.replace(re, fn), cmd);
}

/** 명령에 마스킹 대상 비밀값이 들어 있는가 — 저장 거부·경고 판정용. */
export function containsSecret(cmd: string | null | undefined): boolean {
  return !!cmd && maskCommand(cmd) !== cmd;
}
