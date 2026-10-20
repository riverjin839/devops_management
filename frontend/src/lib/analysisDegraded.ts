// AI 장애 분석 "대체 결과(degraded)" 안내 문구 — 사유(degraded_reason)에 맞춰 원인 방향을 바르게 가리킨다(D-115).
// 사유 접두사는 백엔드 분석기가 만든다: "Claude API 호출 실패" / "LLM 호출 실패" / "… 응답 파싱 실패".

/** 대체 결과 배너·실행 로그의 머리말. 호출 실패면 연결·키 문제로, 파싱 실패면 응답 형식 문제로 안내한다. */
export function degradedHeadline(reason?: string | null): string {
  const r = reason ?? '';
  if (r.includes('호출 실패')) return '분석기 호출에 실패해 대체 결과를 표시합니다';
  if (r.includes('파싱 실패')) return '분석기 응답을 해석하지 못해 대체 결과를 표시합니다';
  return '분석기가 정상 결과를 내지 못해 대체 결과를 표시합니다';
}
