// K8S 자원 관리 화면 공용 포맷/판정 헬퍼 — 페이지·뷰 컴포넌트가 함께 쓴다.

// 분모(whole)가 0/음수면(allocatable 미상 등) 비율을 알 수 없다 — 0%(정상처럼 보임)로
// 위장하지 않고 null 로 구분해 호출부가 "—" 를 표시하게 한다.
export const ratio = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);
export const pctText = (part: number, whole: number): string => {
  const r = ratio(part, whole);
  return r == null ? '—' : `${Math.round(r * 100)}%`;
};
// 코어/밀리코어 단위를 스스로 표기(호출부가 "코어"를 따로 덧붙이면 "500m 코어"처럼 겹친다).
// 음수(과할당 slack)도 부호를 보존해 그대로 표시한다.
export const fmtCores = (m: number): string => {
  const sign = m < 0 ? '-' : '';
  const abs = Math.abs(m);
  return abs >= 1000 ? `${sign}${(abs / 1000).toFixed(1)}코어` : `${sign}${abs}m`;
};
export const fmtGi = (b: number): string => {
  const sign = b < 0 ? '-' : '';
  const abs = Math.abs(b);
  const gi = abs / 1024 ** 3;
  if (gi >= 1) return `${sign}${gi.toFixed(1)}Gi`;
  const mi = abs / 1024 ** 2;
  return `${sign}${mi.toFixed(0)}Mi`;
};
export const fmtN = (n: number) => n.toLocaleString();
// 과할당 노드는 slack(alloc-req) 이 음수가 될 수 있다 — 초록 "여유"로 표시하면 실제로는
// 부족한 노드가 정상처럼 보인다. 부호에 따라 라벨/색을 함께 바꾼다.
export const slackLabel = (m: number) => (m < 0 ? '부족' : '여유');
export const slackCls = (m: number) => (m < 0 ? 'text-status-critical' : 'text-status-healthy');

/** 효율 판정: 사용량/request 비율 → 배지. usage 없으면 null.
 * 임계값(30%/105%)은 UtilPct 와 반드시 동일해야 한다 — 한쪽은 반올림 정수, 한쪽은 원시
 * 비율로 비교하면 같은 값에서 배지 색과 R% 색이 어긋난다(예: r=1.052 일 때 배지=위험,
 * R%=105%=정상으로 보이는 문제). 둘 다 반올림 전 비율로 비교하도록 통일한다. */
export type EffKind = 'over' | 'ok' | 'under' | null;
export function efficiency(reqM: number, usageM: number | null): EffKind {
  if (usageM == null || reqM <= 0) return null;
  const r = usageM / reqM;
  if (r < 0.3) return 'over';       // request 과대(낭비)
  if (r > 1.05) return 'under';     // 실사용이 request 초과(위험)
  return 'ok';
}
export const EFF_BADGE: Record<Exclude<EffKind, null>, { label: string; cls: string }> = {
  over: { label: 'request 과대', cls: 'bg-status-warning/10 text-status-warning border-status-warning/30' },
  ok: { label: '적정', cls: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30' },
  under: { label: '사용 초과', cls: 'bg-status-critical/10 text-status-critical border-status-critical/30' },
};

// 사용률(util): k9s 의 %R / %L. 분류는 표시용 반올림 %가 아니라 원시 비율로 판정한다.
export const utilRatio = (usage: number | null, base: number): number | null =>
  usage == null || base <= 0 ? null : usage / base;
// 표시/CSV 용 반올림 % — 색상 분류는 utilRatio(원시 비율)로 하고, 이건 오직 보여주기용.
export const utilPct = (usage: number | null, base: number): number | null => {
  const r = utilRatio(usage, base);
  return r == null ? null : Math.round(r * 100);
};

export function csvCluster(name: string | undefined): string {
  // 파일명에 안전한 문자만 남긴다. `\w` 는 ASCII 전용이라 한글 클러스터명이 전부 "-" 로
  // 무너져 파일명이 "k8s-alloc-nodes---2026-07-30.csv" 처럼 뭉개졌다 — 유니코드 문자/숫자는
  // 보존하고 구분자/특수문자만 치환한다.
  return (name || 'cluster').trim().replace(/[^\p{L}\p{N}._-]+/gu, '-') || 'cluster';
}
// 로컬(KST 등) 날짜 — UTC 기준(toISOString)이면 자정 이전 내보내기가 하루 밀려 찍힌다.
export const today = () => {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
};

/** 노드 수에 따라 한 행에 표시할 컬럼 수를 동적으로 계산 */
export function calcGridCols(count: number): number {
  if (count <= 1) return 1;
  if (count <= 2) return 2;
  if (count <= 4) return 2;
  if (count <= 6) return 3;
  if (count <= 9) return 3;
  if (count <= 12) return 4;
  if (count <= 16) return 4;
  if (count <= 20) return 5;
  return 6;
}
