/**
 * HTML 문자열에 끼워 넣을 값을 이스케이프한다.
 *
 * force-graph(react-force-graph-3d) 의 `nodeLabel`/`linkLabel` 툴팁은 문자열을 HTML 로 DOM 에 넣는다 —
 * 클러스터 이름·엔티티 이름처럼 사용자가 저장한 값을 그대로 이어 붙이면 저장형 XSS 가 된다(D-181 라운드
 * 15차 감사). 툴팁 HTML 을 문자열로 조립하는 곳은 사용자·외부 값마다 반드시 이 함수를 거친다.
 */
export function escapeHtml(v: unknown): string {
  return String(v ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] ?? c
  ));
}
