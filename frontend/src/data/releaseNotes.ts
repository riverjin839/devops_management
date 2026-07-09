// 릴리즈 노트 — 사이드바 "릴리즈 노트" SidePane 에 표시되는 사용자용 변경 요약.
//
// 전체 구현 상세는 저장소 루트 CHANGELOG.md 가 원본(source of truth)이며, 여기는 그 중
// 사용자 관점에서 의미 있는 항목만 간추린 사본이다. feat/fix PR 로 CHANGELOG.md 를 갱신할 때
// 사용자에게 보여줄 만한 변경이면 이 배열에도 함께 반영한다 (CLAUDE.md CHANGELOG 정책과 별개로,
// 자동 동기화는 하지 않으므로 수동으로 맞춘다).

export interface ReleaseNoteEntry {
  version: string;
  date: string; // YYYY-MM-DD
  highlights: string[];
}

export const RELEASE_NOTES: ReleaseNoteEntry[] = [
  {
    version: 'Unreleased',
    date: '',
    highlights: [
      'Jira Excel 가져오기 — 기존 .xlsx 뿐 아니라 구버전 .xls(Excel 97-2003) 파일도 업로드 가능',
      '담당자별 진행 현황 — 전체 참석(파트 회의 등) 업무를 "전체" 카드로 최우선 노출, 인당 표시' +
        ' 개수 옵션(기본 5개) 추가',
      '업무 등록 버튼이 페이지 이동 없이 팝업으로 열리도록 개선, 등록 폼 옵션 정리(우선순위/보드' +
        ' 상태/프로젝트/스프린트 제거, 날짜 기본값 단순화)',
      '업무 등록 시 서비스 선택을 카테고리 기준으로 완화 — 회의/교육 등은 서비스 없이도 등록 가능',
      '서비스 모듈 관계도(/architecture) — PEP 아키텍처 · 클러스터 토폴로지 애니메이션 다이어그램',
      'K8s 클러스터 추이(Cluster Trends) — 노드별 CPU/Memory/Disk/Network 시계열 조회',
      'K8s 자원 관리 — 사용률(R/L) 표시, 노드 카드 열 수 선택, 검색 필터',
      '지식 허브 통합 — 지식/분석 메뉴를 /docs 하나로 통합, 필터 칩 추가',
      '업무 상세 페이지에서 바로 수정 (별도 수정 페이지 제거)',
      '사용자 메뉴 개편 — 우측 슬라이드 패널로 셀프 서비스 정보 수정',
      '담당자 관리 — 좌석 위치, CSV/마크다운 내보내기',
      'K8s 노드 이미지 CSV 내보내기',
      'Jira Excel 가져오기(.xlsx) — 담당자 자동 매핑',
      'mc 클라이언트 레이아웃 개선',
      '감사 로그를 Settings ▸ 감사 로그 탭으로 이동',
      '업무 게시판 날짜 저장 오류, 노드 이미지 CSV 다운로드 한글 파일명, 파일 업로드 인터셉터, ' +
        'Jira Excel 업로드 크기 제한, Work to do 500 에러 등 다수 버그 수정',
    ],
  },
  {
    version: '1.0.0',
    date: '2026-06-04',
    highlights: [
      '플랫폼 엔지니어링 포털(PEP) 첫 정식 릴리스',
      'K8s 클러스터/노드/시스템 파드 모니터링, 일일 점검 3회/일',
      '운영 점검(Ops Checks) 콘솔 — 인증서/etcd/CNI/PVC/OOM 등 다수 deep checker',
      '이슈 → 자동 재점검, Cilium/Hubble 라이브 트레이스, AI 장애 분석',
      'Ansible 플레이북/배치 작업, etcdctl/mc 콘솔',
      '업무/이슈 보드, WBS, 워크플로우, 마인드맵, 문서 에디터(TipTap)',
      'OpenLens 차용 — 파드 로그 스트리밍, 리소스 탐색기',
      'kind/Helm/Kustomize/ArgoCD/Jenkins 배포, JSON 백업/복원, RBAC',
    ],
  },
];
