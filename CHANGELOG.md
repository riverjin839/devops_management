# Changelog

이 프로젝트의 주요 변경을 기록한다. 형식은 [Keep a Changelog], 버전은 [SemVer] 를 따른다.
브랜치·태그·릴리스 절차는 `docs/branch-tag-strategy.md` 참고.

[Keep a Changelog]: https://keepachangelog.com/ko/1.1.0/
[SemVer]: https://semver.org/lang/ko/

## [Unreleased]

1.0.0 이후 main 에 병합된 변경 (다음 마이너 릴리스 후보).

### Added
- **K8s 클러스터 추이(Cluster Trends)** — 신규 메뉴 `/cluster-trends`. per-node CPU/Memory/Disk/DiskIO/Network/NetworkErr
  시계열을 시간창(30m/1h/6h/24h/7d)별로 조회. 300+ 노드 과수집 방지(노드 명시 선택 + 상한 기본 30,
  시간창별 step 자동조정, 지표당 range query 1회). 데이터 소스는 클러스터별 Prometheus URL(미설정/비활성 시 offline).
  - Backend: `PrometheusService.query_range()`(fail-safe), `Cluster.prometheus_url/prometheus_enabled` 컬럼,
    `cluster_trends` 라우터, config `PROMETHEUS_NODE_LABEL`(기본 instance)·`TRENDS_MAX_NODES`(기본 30).
- **K8s 자원 관리 — 사용률(R/L) 표시**: k9s util 스타일로 모든 탭에 `R=사용/요청`·`L=사용/제한` 노출
  (노드 카드/테이블, 네임스페이스, 워크로드/파드 드릴다운). CSV 에도 사용률 컬럼 추가.
- **K8s 자원 관리 — 노드 카드 "열 수" 선택**(자동/5/10/20) + **네임스페이스·비효율 랭킹 페이징**
  (`PageSizeSelect`/`Pager`/`paginate`). 노드/네임스페이스 **검색 필터** 추가.
- **지식 허브 통합**: 지식/분석 메뉴를 `/docs` 하나로 통합(지식베이스·Q&A·마인드맵·온톨로지·기술동향·작업가이드를
  허브 탭/목록에서 접근). 관리자 '기존 자료 가져오기'(SOP/운영노트 → 지식문서, 중복 skip, 비파괴).
- **오픈소스/CNCF 브랜드 아이콘** 50종(`simple-icons`) — 클러스터·서비스 아이콘 picker 에 추가.
- **업무 게시판**: 시작일/완료일 **시간 표시 옵션**(기본 off=날짜만), **이번주(월~일) 빠른 필터**.
- **지식 허브 필터**: "필터" 타이틀 라인을 제거해 공간을 확보하고, 이번 주/이번 달/이번 분기 및 스프린트
  필터 칩을 추가.
- **업무 상세 페이지 바로 수정**: 우측 상단 "수정" 버튼과 별도 수정 페이지(라우트)를 없애고, 제목 옆
  연필 버튼이나 본문 클릭으로 그 자리에서 바로 편집 모드(기존 폼)로 전환.
- **사용자 메뉴 개편**: 사이드바 사용자 아이콘 클릭 시 작은 팝업 대신 우측 슬라이드 SidePane 으로 전환,
  상단에 본인 담당자 정보(이메일/IP/좌석 위치/정·부 담당역할)를 바로 수정할 수 있는 셀프 서비스 폼 추가,
  하단에 비밀번호 변경 메뉴.
- **담당자 관리**: 좌석 위치(`seatLocation`) 필드 추가, Settings ▸ 담당자 탭에 CSV 내보내기와 마크다운
  표 클립보드 복사 버튼 추가.
- **K8s 노드 이미지 CSV 내보내기**: 노드 순서/용량 기준/라인 수 기준 정렬 옵션을 지원하는 CSV 다운로드
  추가 (`/clusters/{id}/node-images/export.csv`).
- **Jira Excel 가져오기**: Jira 에서 추출한 이슈 목록 `.xlsx` 를 업로드하면 Key/Summary/Issue Type/
  Status/Assignee/Created/Resolved/Due Date/Environment/Description 을 테이블로 미리보기(저장 없음).
  Assignee 셀("이름 회사")에서 이름을 추출해 등록된 담당자와 자동 매핑. 신규 페이지 `/jira-import`.
  - Backend: `POST /jira/import/excel` (openpyxl).
- **mc 클라이언트 레이아웃**: 타겟/프리셋/결과 카드를 2:3:5 비율로 한 행에 배치, 결과 카드는 항상 같은
  위치에 고정되고 세로 스크롤만 허용(가로 스크롤 없음).

### Changed
- **플랫폼 현황 메뉴 정리**: 사이드바·홈 퀵 액세스에서 "서비스/앱"(LAKE 서비스·애플리케이션 APM) 메뉴
  제거 (라우트/페이지 자체는 유지, 메뉴에서만 제거).

### Fixed
- **업무 게시판 날짜 저장 오류**: 날짜 input 이 빈 값('')으로 전송되면 `started_at`/`closed_at` 가
  `Input should be a valid datetime` 422 로 거부되어 상태를 done 으로 바꾸거나 완료일을 비울 때 저장 실패하던 문제 →
  스키마 `field_validator` 로 빈 문자열/공백을 `None` 으로 강제(WorkItemBase·WorkItemUpdate).
- 컬럼 리사이즈 그립을 평소에도 옅게 노출(`ResizeGrip`) — 컬럼 너비 조정 기능 발견성 개선(모든 테이블 공통).
- **업무 수정 딥링크**: `/tasks-mgmt/:id/edit` 라우트 제거 후 남아있던 구 북마크/딥링크가 캐치올에 걸려
  홈으로 튕기던 문제 → 상세 페이지 편집 모드(`?edit=1`)로 리다이렉트.
- **노드 이미지 CSV 다운로드**: 클러스터명에 한글 등 non-ASCII 문자가 있으면 `Content-Disposition`
  헤더 인코딩 실패로 500 이 나던 문제 → ASCII fallback + RFC 5987 `filename*` 인코딩.
- **파일 업로드 API 인터셉터**: `FormData`/`Blob` 페이로드가 camelCase→snake_case 변환기를 거치며
  빈 객체로 뭉개지던 문제 → multipart 업로드(백업 가져오기 포함) 전반에 영향이 있어 함께 수정.

## [1.0.0] - 2026-06-04 — 정식 오픈

플랫폼 엔지니어링 포털(PEP) 첫 정식 릴리스.

### 핵심 기능 (요약)
- **K8s 모니터링**: 일일 점검(3회/일 Celery Beat), 클러스터/노드/시스템 파드 헬스, addon 점검, AI 리뷰.
- **운영 점검(Ops Checks) 콘솔**: 점검 항목 리스트 → 선택 일괄/개별 실행(백그라운드 진행률) → 결과·로그.
  deep checker 다수(인증서/etcd/CNI/PVC/OOM/노드/CoreDNS/외부도달/Pod-to-Pod/**OS 파라미터 변경**/**MinIO health**).
- **이슈→자동 재점검**: alert webhook 수신 시 해당 클러스터 점검 자동 트리거(쿨다운).
- **딥 트러블슈팅**: Cilium/Hubble 라이브 트레이스, 패킷 흐름, AI 장애 분석, Pod 병목 진단.
- **자동화**: Ansible 플레이북/배치 작업(SSH), etcdctl/mc 콘솔, 노드 일괄 실행.
- **설정 변경 히스토리**: ClusterConfigSnapshot(해시 dedup) + diff + 감사 로그.
- **협업/지식**: 업무/이슈 보드(칸반/표/캘린더), 주간 타임라인(간트), WBS, 워크플로우, 마인드맵,
  운영 노트/가이드/서비스 허브.
- **문서 에디터(TipTap)**: 실무 템플릿 5종(작업계획서/이슈대응/운영런북/스터디/명령어표),
  **.md import**, **표 편집(엑셀형)**, **배경색 컬러 피커**, **붙여넣기 이미지 자동 경량화**.
- **OpenLens 차용(읽기전용)**: **파드 로그 스트리밍**(SSE follow), **리소스 탐색기**(11종 + YAML 읽기,
  Secret 마스킹) + **가상화(react-virtuoso)**.
- **운영**: kind/Helm/Kustomize/ArgoCD/Jenkins 배포, JSON 백업/복원(fault-tolerant), RBAC(viewer/operator/admin).

### 문서
- `docs/openlens-architecture-roadmap.md` — 범용 K8s 관리 + 300노드 실시간 로드맵(P0~P5).
- `docs/collab-tooling-borrow-report.md` — AFFiNE/AppFlowy 차용 분석.
- `docs/branch-tag-strategy.md` — 본 릴리스부터의 브랜치·태그 전략.
- `.claude/skills/` — 재사용 작업 플레이북(점검 추가/백엔드/프론트/에디터/릴리스).

### 알려진 보류(post-1.0 백로그)
- 도식(draw.io 벡터 임베드), 협업 Top7(슬래시 메뉴/댓글·이력/백링크/마인드맵 내보내기/커스텀 필드).
- OS 파라미터 변경 **가시화 UI**(이력 테이블은 적재 중).
- Storage Ceph/Isilon health, MinIO drive/capacity, 진짜 외부 vantage 도달성.
- OpenLens P1 확장(Discovery/CRD·Monaco), P2 실시간(WebSocket/Go 사이드카), P4 Runbook 파이프라인,
  P5 admin YAML 편집(설계상 보류).

[1.0.0]: https://github.com/riverjin839/devops_management/releases/tag/v1.0.0
