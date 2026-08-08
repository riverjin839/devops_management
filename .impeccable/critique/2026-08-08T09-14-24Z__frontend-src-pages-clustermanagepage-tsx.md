---
target: /cluster-manage (ClusterManagePage.tsx)
total_score: 31
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 4
timestamp: 2026-08-08T09-14-24Z
slug: frontend-src-pages-clustermanagepage-tsx
---
Method: dual-agent (A: design review · B: detector + evidence)

## /cluster-manage (클러스터 관리) — Design Critique

### Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 3/4 | freshness(수집 시각) 표시 전무 |
| 2 | Match System / Real World | 4/4 | bond0/bond1·BGP/AS·kubectl 플래그 단위 provenance |
| 3 | User Control and Freedom | 3/4 | "IP 수집"은 diff 없이 즉시 쓰기 |
| 4 | Consistency and Standards | 3/4 | 겹침 표시가 카드(5색)와 테이블(칩)에서 다른 언어 |
| 5 | Error Prevention | 3/4 | dataType 변경만 무확인 즉시 적용 |
| 6 | Recognition Rather Than Recall | 4/4 | 전 컬럼 provenance 툴팁 — 레포 최고 |
| 7 | Flexibility and Efficiency | 3/4 | 헤더 정렬·기본 컬럼 숨김·검색 단축키 없음 |
| 8 | Aesthetic and Minimalist Design | 2/4 | IP 컬럼 4개(≈900px) 중복 + 툴바 6개 동일 비중 |
| 9 | Error Recovery | 3/4 | 일괄 수집 실패 catch { fail += 1 } 익명 집계 |
| 10 | Help and Documentation | 3/4 | 툴팁=마이크로 문서 |
| Total | | 31/40 | Good |

### Specificity / Detector
Authored (glob IP 압축·BFS 겹침 그룹·CGNAT 인지 분류). detect.mjs 1건(ClusterCard.tsx:66 border-l-4)은 false positive — --status-* 토큰 기능색, dot+배지 중복 인코딩. 브라우저 증거 생략(dev 서버 없음).
D-041~D-053 회귀 검증: 10건 유지, 회귀 없음. 미완 2건 — D-052(KeyboardSensor 미등록), D-042 클래스가 ClusterCustomFieldsManager 재발.

### Priority Issues (15건: P0 1 · P1 4 · P2 5 · P3 5)

[P0] 실행 버튼 4개 전부 CLAUDE.md 실행-로그 규칙 위반 — 일괄 수집 실패가 catch { fail += 1 }(ClusterManagePage.tsx:467)로 익명, 재수집/IP수집은 스피너+토스트만, NIC 수집은 완료 후 일괄 도착(실시간 아님)+성공 호스트 raw 미노출. Fix: LogViewer per-run 로그 드로어 + "로그 보기" 토글 + 실패 재시도. Command: harden

[P1] 드래그 정렬 포인터 전용 — PointerSensor 만(ClusterManagePage.tsx:277), 그립이 보이는데 안 움직임(D-052 미완). Command: harden
[P1] ClusterCustomFieldsManager silent save 재발 — quickLabel/shift(:114-125) try/catch·피드백 없음, shift 순차 2회 mutation 비원자(sortOrder 중복 livelock), ▲/▼ pending 미비활성. Command: harden
[P1] 커스텀 필드 오류=빈 상태 동일 렌더 — isError 분기 없음(:163-172), 페이지(:180)도 실패 시 컬럼 조용히 소실. Command: harden
[P1] 포커스 무표시 광역 — 인라인 편집 전부(InlineEdit), operationLevel select, 커스텀필드 매니저 5곳, NIC 모달 password 포함 6곳+체크박스. Command: harden

[P2] per-row "IP 수집" confirm/diff/로그 없이 즉시 발사(ClusterTableRow.tsx:410-421) — 일괄 경로는 confirm 게이트인데 단건 무게이트. Command: harden
[P2] 카드 뷰 겹침 그룹 색상 단독(overlapPeers 미전달, ClusterManagePage.tsx:790-802) — hue 대조로만 파악. Command: harden
[P2] IP 컬럼 4개 중복 — INTERNAL_IP+네트워크 요약 셀로 접고 상세는 행 확장/사이드 패널, 컬럼 관리에 기본 컬럼 숨김. Command: distill+layout
[P2] 툴바 6개 동일 비중 + 검색 토글 뒤 — 검색 상시 노출, 희귀 도구 "⋯" 드롭다운. Command: layout+distill
[P2] ClusterCustomCell 체크박스 — in-flight 가드 없는 연타 PATCH 레이스 + SR 에 "O/X/·"만 announce. Command: harden

[P3] freshness 미표시 / CiliumConfigModal 오류 detail 누락+이모지 잔존 / 스켈레톤 columns=8 vs 실제 14+ / NIC 모달 label 미연결 / ⓘ 툴팁 title 전용(키보드·SR 접근 불가)

### Persona Red Flags
Alex: 검색 토글 뒤·헤더 정렬 없음·일괄 수집이 !nodeIps 대상만·"실패 3" 막다른 골목.
Sam: 키보드 정렬 불능·체크박스 "O" announce·NIC 무라벨 자격증명·표준화 버튼 busy 중 이름 상실.
Riley: 순차 일괄 수집 hang 전파·300노드 NIC 스피너만·shift livelock.
지수(폐쇄망): SSH 설정 매번 재입력, 로그 공백이 가장 아픔. 민준(viewer): 복사 칩이 카드 뷰 전용, select-none 이 드래그 복사 방해.

### Questions
1. 이 화면은 하나인가 셋인가 — CIDR 충돌 전용 뷰가 필요하지 않나?
2. diff 의 old→new 를 apply 순간 증발시키지 말고 행 변경 이력으로?
3. glob IP 표기가 시그니처라면 왜 테이블에서 복사 불가?
