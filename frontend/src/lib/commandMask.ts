// 명령 문자열의 비밀값 마스킹(D-176) — 서버 `backend/app/services/command_mask.py` 와 같은 규칙·같은 순서.
//
// 확인창·결과 패널·실행 로그·저장 명령 표시에 명령 원문을 보여줄 때 반드시 이 함수를 거친다.
// 규칙을 바꾸면 서버 쪽 정규식도 같은 커밋에서 바꾼다(감사 로그와 화면 표시가 어긋나지 않게).
// 사례 목록의 원천은 서버 테스트 `backend/tests/test_command_mask.py`(GAP_CASES 포함)다.
//
// 대소문자 무시. 값 부분만 `****` 로 바꾸고 플래그·변수 이름은 남긴다. 마스킹은 멱등이다.
// 값 = 셸 단어 하나(따옴표 안 공백 포함, 따옴표 밖 공백·`;&|<>` 전까지, `'pa'"'"'ss'` 도 한 단어).
//
// | 입력                                                      | 출력                                              |
// |-----------------------------------------------------------|---------------------------------------------------|
// | `get / --user root:s3cret --prefix`                       | `get / --user root:**** --prefix`                 |
// | `--user="root:s3 cret"` · `ETCDCTL_USER='root:pw'`        | `--user="root:****"` · `ETCDCTL_USER='root:****'` |
// | `--password=abc` · `--passwd x` · `--api-key=k`           | `--password=****` · `--passwd ****` · `--api-key=****` |
// | `--access-token t` · `--client-secret s`                  | `--access-token ****` · `--client-secret ****`    |
// | `ETCDCTL_PASSWORD='pa'"'"'ss'` · `DB_PASS=x` · `MYSQL_PWD=x` | `ETCDCTL_PASSWORD=****` · `DB_PASS=****` · `MYSQL_PWD=****` |
// | `alias set --api S3v4 prod https://s3:9000 AK SK`         | `alias set --api S3v4 prod https://s3:9000 **** ****` |
// | `config host add prod url AK SK`                          | `config host add prod url **** ****`              |
// | `curl -u user:pw` · `mysql -ppw`                          | `curl -u user:****` · `mysql -p****`              |
// | `redis://:pw@h` · `https://u:p@ss/w@h`                    | `redis://:****@h` · `https://u:****@h`            |
// | `MC_HOST_x=https://AK:SK@h:9000` · `sshpass -p pw`        | `MC_HOST_x=https://****:****@h:9000` · `sshpass -p ****` |
// | `curl -H "Authorization: Bearer eyJhbGc"`                 | `curl -H "Authorization: Bearer ****"`            |
//
// 그대로 두는 것: `--key=/a.key`(TLS 키 경로) · `--keys-only` · `--passphrase X` · `--no-password` ·
// `mysql -p db` · `PWD=/tmp` · `docker run -u 1000:1000`.

/** 셸 단어 — 서버 `_WORD` 와 동일. 닫히지 않은 따옴표는 끝까지 값으로 본다. */
const WORD = String.raw`(?:'[^']*'?|"(?:[^"\\]|\\.)*"?|\\.|[^\s'"\\;&|<>])+`;

const MASK = '****';

/** `alias set` 에서 값을 하나 받는 플래그(소문자 비교) — 서버 `_VALUE_FLAGS` 와 동일. */
const VALUE_FLAGS = new Set(['--api', '--path', '--config-dir', '-c']);

type Replacer = (match: string, ...groups: string[]) => string;
const keepHead: Replacer = (_m, head) => `${head}${MASK}`;

/** `name:secret` → `name:****`. 콜론이 없으면 그대로. 여는 따옴표는 닫아 준다. */
function maskAfterColon(word: string): string {
  const idx = word.indexOf(':');
  if (idx < 0) return word;
  const head = word.slice(0, idx + 1);
  const first = head[0];
  const opened = (first === "'" || first === '"') && head.split(first).length % 2 === 0;
  return `${head}${MASK}${opened ? first : ''}`;
}

const headAfterColon: Replacer = (_m, head, word) => `${head}${maskAfterColon(word)}`;

/** `alias set` 뒤 인자 — 플래그(와 값)를 건너뛴 위치 인자 중 URL 다음 두 개(없으면 3·4번째)를 가린다. */
function maskMcAliasTail(tail: string): string {
  const toks = Array.from(tail.matchAll(new RegExp(String.raw`(\s+)(${WORD})`, 'g')), (m) => [m[1], m[2]]);
  const positional: number[] = [];
  let skipNext = false;
  toks.forEach(([, w], i) => {
    if (skipNext) {
      skipNext = false;
      return;
    }
    if (w.startsWith('-') && w.length > 1) {
      skipNext = !w.includes('=') && VALUE_FLAGS.has(w.toLowerCase());
      return;
    }
    positional.push(i);
  });
  const urlPos = positional.findIndex((i) => toks[i][1].includes('://'));
  const secret = urlPos >= 0 ? positional.slice(urlPos + 1, urlPos + 3) : positional.slice(2, 4);
  for (const i of secret) toks[i][1] = MASK;
  return toks.map(([ws, w]) => ws + w).join('');
}

// 순서대로 적용한다 — 서버 `_RULES` 와 같은 순서·패턴.
const RULES: Array<[RegExp, Replacer]> = [
  // 1. mc alias set / config host add
  [new RegExp(String.raw`(\b(?:alias\s+set|config\s+host\s+add))((?:\s+${WORD})+)`, 'gi'),
    (_m, head, tail) => `${head}${maskMcAliasTail(tail)}`],
  // 2. 비밀 플래그 --X[= ]값
  [new RegExp(String.raw`(--(?!no-)(?:[\w-]*(?:password|passwd|token|secret)|pass|apikey|[\w-]+-key)(?:=|\s+))${WORD}`, 'gi'),
    keepHead],
  // 3. --user name:X · curl -u name:X · …USER=name:X
  [new RegExp(String.raw`(--user(?:=|\s+))(${WORD})`, 'gi'), headAfterColon],
  [new RegExp(String.raw`(\bcurl\b[^;&|\n]*?\s-[a-z]*u\s*)(${WORD})`, 'gi'), headAfterColon],
  [new RegExp(String.raw`(\w*USER=)(${WORD})`, 'gi'), headAfterColon],
  // 4. env 대입
  [new RegExp(String.raw`((?:PASSWORD|PASSWD|SECRET|TOKEN|ACCESS_KEY|SECRET_KEY|API_KEY|(?:\b|_)PASS|_PWD)[A-Z_]*=)${WORD}`, 'gi'),
    keepHead],
  // 5. mysql -pX (대소문자 구분 — -P 는 포트)
  [new RegExp(String.raw`(\b(?:mysql|mysqldump|mysqladmin|mariadb)\b[^;&|\n]*?\s-p)${WORD}`, 'g'), keepHead],
  // 6. Authorization 헤더
  [/(Authorization:\s*(?:Bearer|Basic|Token)\s+)[^\s'"]+/gi, keepHead],
  // 7. MC_HOST_<alias>=scheme://ACCESS:SECRET@host
  [/(MC_HOST_\w*=['"]?[a-z][a-z0-9+.-]*:\/\/)[^:@\s'"/]*:[^\s'"]*@/gi, (_m, head) => `${head}${MASK}:${MASK}@`],
  // sshpass -p X
  [new RegExp(String.raw`(\bsshpass\s+-p\s*)${WORD}`, 'gi'), keepHead],
  // scheme://user:X@host — 빈 user 허용, X 는 마지막 @ 까지(@·/ 포함 비밀번호)
  [/([a-z][a-z0-9+.-]*:\/\/[^:@\s'"/]*:)[^\s'"]*@/gi, (_m, head) => `${head}${MASK}@`],
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
