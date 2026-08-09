---
target: /versions (VersionsPage.tsx)
total_score: 29
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 5
timestamp: 2026-08-08T12-10-11Z
slug: frontend-src-pages-versionspage-tsx
---
Method: dual-agent (A: design review · B: detector + evidence)

## /versions (버전·설정) — Design Critique

### Design Health Score
| # | Heuristic | Score | Key Issue |
|---|---|---|---|
| 1 | Visibility of System Status | 2/4 | 300노드 SSH fan-out 이 스피너 하나 — per-host 진행/로그 전무 |
| 2 | Match System / Real World | 4/4 | systemctl show·ps·EC parity·distroless 근거 — 오퍼레이터 모국어 |
| 3 | User Control and Freedom | 3/4 | 전 mutation abortable — Escape 가 in-flight 가드 우회, diff 방향 스왑 불가 |
| 4 | Consistency and Standards | 2/4 | 2세대 혼재: NodeNics 토큰·ring 완비 vs 나머지 고정 팔레트 |
| 5 | Error Prevention | 3/4 | certs "모두"가 안내문과 모순, 300노드 fan-out 무확인 |
| 6 | Recognition Rather Than Recall | 3/4 | 기본값+help 우수 — SSH 자격증명 5회 재입력 |
| 7 | Flexibility and Efficiency | 3/4 | 통합 수집 플로우 부재 |
| 8 | Aesthetic and Minimalist Design | 2/4 | 헤더 9개 동급 컨트롤 |
| 9 | Error Recovery | 3/4 | 모든 오류 목록 slice(0,3) 절단 |
| 10 | Help and Documentation | 4/4 | dedup 의미론·distro 관례를 제자리에서 가르침 |
| Total | | 29/40 | Good(하단) |

### Specificity / Detector
Authored, deeply (sysctl un-camel, etcd provenance 배지, MinIO EC 문장화). 문제는 accretion+일관성 부채. detect.mjs `[]` — true negative. 브라우저 증거 생략.

### Priority Issues (18건: P0 1 · P1 5 · P2 7 · P3 5)

[P0] 실행 버튼 8개 전부 실행-로그 규칙 미충족 — 지금수집/MinIO 토스트만+slice(0,3) 절단(VersionsPage.tsx:841-871), 4개 모달 요약표만(raw 미렌더). 결정적: NodeNics raw 뷰어가 h.raw_stdout 를 읽지만 axios 인터셉터가 rawStdout 로 camelize → 항상 undefined, 영원히 미렌더(types/index.ts:2221-2223 vs services/api.ts:21-28). 백엔드도 성공 호스트 raw 미첨부. Fix: 타입 camelCase 정정+백엔드 성공 raw, RawOutputDetails 공용화, 페이지 수집 2종에 수집 로그 패턴, slice(0,3)→펼침 전체. Command: harden

[P1] EtcdSystemdModal "systemd unit" 입력 플라시보 — unit 이 payload 로 미전송(EtcdSystemdModal.tsx:60-69), 표시만 바뀜. 기능 버그+UI-First 위반. Command: harden
[P1] 메인 조회 실패가 "스냅샷 없음" EmptyState 로 위장(VersionsPage.tsx:1100-1106) — HistoryTimeline/DiffPanel/4개 모달 노드목록 동일(NodeNics 만 3분기 완비). Command: harden
[P1] SSH 자격증명 입력란 포커스 표시 전무 ×4 모달 — 검색창은 focus:ring-0 이중 opt-out. Command: harden
[P1] SSH 자격증명 5회 재입력 — 세션 메모리 공유 컨텍스트 필요. Command: design/distill

[P2] 헤더 9개 동급 → SSH 수집 5종 단일 메뉴(layout+distill) / 닫기 X 5곳 title·aria 누락 / etcd·certs 상태 셀 아이콘-색 단독 / Escape 가 수집 중 모달 닫음(useModalA11y 무조건 onClose) / NodeNics 수집 무확인 덮어쓰기 / 고정 팔레트 광역(CATEGORY_META·diff·중지, 4개 모달) / 인포배너·검색바 수제 bg-card(D-004)

[P3] slice(0,3) 절단 6곳 / diff 방향 클릭순서 의존 / certs "모두" 모순 / EmptyState 지금수집 pending 미가드 / DirectPV >85% 색상 단독

### Persona Red Flags
Alex: 비밀번호 ×5, diff 패널 최하단+scrollIntoView 없음, 분 단위 타임스탬프. Sam: X 5곳 무명, 검색창 무라벨, 자격증명 포커스 무표시, 결과 소멸성 토스트. Riley: "최근 뭐가 바뀌었나" 크로스 뷰 부재. 지수: /etcd/etcd.env 프론트 하드코딩. 민준(viewer): 수집 버튼 역할 게이팅 없음.

### Questions
1. SSH 수집기 5개 = 단일 "노드에서 수집" 플로우 1회 SSH 패스로?
2. 해시 dedup 인데 왜 drift 감지가 사람 클릭 의존 — check-matrix cron 스케줄링?
3. 감정 정점이 diff 인데 랜딩이 정적 인벤토리 — "최근 변경" 체인지로그가 첫 화면?
