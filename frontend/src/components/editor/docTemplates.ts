/**
 * 엔지니어/운영 실무 문서 템플릿 — 에디터 툴바의 "템플릿" 메뉴에서 본문에 삽입.
 *
 * 원칙(사용자 요청):
 *  - 실무에 실제로 쓰는 것만. 군더더기/안 쓰는 템플릿 금지.
 *  - 이미지 없이 텍스트·체크리스트·표 중심으로 경량 유지.
 *  - HTML 은 현재 TipTap 확장(heading/list/taskList/table/blockquote/hr)만으로 렌더 가능.
 */

export interface DocTemplate {
  id: string;
  label: string;
  description: string;
  html: string;
}

const TASK = (text: string) =>
  `<li data-type="taskItem" data-checked="false">${text}</li>`;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 표 셀 보정 — 빈 `<td></td>` / `<th></th>` 는 ProseMirror tableCell 스키마(block+)를 위반해
 * insertContent 시 `RangeError: invalid content for node tableCell` 가 나고 삽입 자체가 실패한다.
 * 빈 셀에 빈 문단(`<p></p>`)을 넣어 유효한 블록 콘텐츠를 보장한다. (모든 템플릿 삽입 직전에 호출)
 */
export function normalizeTemplateHtml(html: string): string {
  return html.replace(/<(td|th)([^>]*)>(\s*)<\/\1>/g, '<$1$2><p></p></$1>');
}

/**
 * 파트 데일리 회의록 분담표 HTML 생성 — Settings 에 등록된 담당자를 표의 '담당자' 열에 한 명씩 자동 채운다.
 * 컬럼: 담당자 | 업무 내용 | 업무 환경 | 완료 예정일 | Jira 링크 | Confluence 링크 | 기타.
 * 담당자마다 여러 업무를 적으려면 표 편집(행 아래 추가) 또는 마지막 셀에서 Tab 으로 행을 늘린다.
 * 컬럼 폭은 에디터에서 경계를 드래그해 조절할 수 있다(표 컬럼 리사이즈).
 */
export function buildAssigneeWorkTable(assigneeNames: string[]): string {
  const headers = ['담당자', '업무 내용', '업무 환경', '완료 예정일', 'Jira 링크', 'Confluence 링크', '기타'];
  const headRow = `<tr>${headers.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  const names = assigneeNames.map((n) => n.trim()).filter(Boolean);
  const rows = names.length ? names : [''];
  const emptyCells = headers.slice(1).map(() => '<td><p></p></td>').join('');
  const bodyRows = rows
    .map((name) => `<tr><td><p>${escapeHtml(name)}</p></td>${emptyCells}</tr>`)
    .join('');
  return `<h2>파트 데일리 회의록</h2>\n<table><tbody>${headRow}${bodyRows}</tbody></table>`;
}

/** 위 분담표를 템플릿 메뉴 항목(DocTemplate)으로 포장. 등록된 담당자 목록에 따라 동적으로 만든다. */
export function assigneeWorkTableTemplate(assigneeNames: string[]): DocTemplate {
  return {
    id: 'assignee-worktable',
    label: '파트 데일리 회의록',
    description: 'Settings 담당자 자동 입력 — 담당자·업무 내용·환경·완료 예정일·Jira·Confluence·기타',
    html: buildAssigneeWorkTable(assigneeNames),
  };
}

export const DOC_TEMPLATES: DocTemplate[] = [
  {
    id: 'work-plan',
    label: '작업 계획서',
    description: '변경/작업 전 계획 — 절차·롤백·검증 체크리스트',
    html: `
<h2>작업 계획서</h2>
<table><tbody>
<tr><th>항목</th><th>내용</th></tr>
<tr><td>작업명</td><td></td></tr>
<tr><td>담당 / 협조</td><td></td></tr>
<tr><td>일시 / 소요</td><td></td></tr>
<tr><td>대상(클러스터/노드/서비스)</td><td></td></tr>
<tr><td>영향도 / 다운타임</td><td></td></tr>
</tbody></table>
<h3>목적 / 범위</h3>
<p></p>
<h3>사전 점검</h3>
<ul data-type="taskList">${TASK('현재 상태/버전 스냅샷 확보')}${TASK('백업/스냅샷 확인')}${TASK('롤백 가능 여부 확인')}${TASK('관련 담당자 공지')}</ul>
<h3>실행 절차</h3>
<ol><li>...</li><li>...</li></ol>
<h3>검증</h3>
<ul data-type="taskList">${TASK('정상 동작 확인 항목')}${TASK('모니터링/알람 정상')}</ul>
<h3>롤백 계획</h3>
<ol><li>...</li></ol>
<h3>비고</h3>
<p></p>`.trim(),
  },
  {
    id: 'incident',
    label: '이슈 대응 문서',
    description: '장애/이슈 — 타임라인·원인·재발방지(포스트모템)',
    html: `
<h2>이슈 대응 문서</h2>
<table><tbody>
<tr><th>항목</th><th>내용</th></tr>
<tr><td>발생 일시</td><td></td></tr>
<tr><td>심각도</td><td>(critical / warning / minor)</td></tr>
<tr><td>영향 범위</td><td></td></tr>
<tr><td>상태</td><td>(진행중 / 완화 / 해결)</td></tr>
<tr><td>담당</td><td></td></tr>
</tbody></table>
<h3>증상</h3>
<p></p>
<h3>타임라인</h3>
<table><tbody>
<tr><th>시각</th><th>이벤트 / 조치</th></tr>
<tr><td></td><td></td></tr>
</tbody></table>
<h3>원인</h3>
<p><strong>직접 원인:</strong> </p>
<p><strong>근본 원인:</strong> </p>
<h3>조치 내용</h3>
<ul data-type="taskList">${TASK('임시 조치')}${TASK('영구 조치')}</ul>
<h3>재발 방지</h3>
<ul data-type="taskList">${TASK('모니터링/알람 보강')}${TASK('런북/문서화')}${TASK('자동화')}</ul>
<h3>관련 링크</h3>
<ul><li></li></ul>`.trim(),
  },
  {
    id: 'ops-runbook',
    label: '운영 대응 양식(런북)',
    description: '상황별 점검·대응 절차·확인 명령어·에스컬레이션',
    html: `
<h2>운영 런북</h2>
<p><strong>대상 / 상황:</strong> </p>
<h3>점검 항목</h3>
<ul data-type="taskList">${TASK('서비스 상태')}${TASK('리소스(CPU/Mem/Disk)')}${TASK('의존 컴포넌트')}</ul>
<h3>대응 절차</h3>
<ol><li>...</li><li>...</li></ol>
<h3>확인 명령어</h3>
<table><tbody>
<tr><th>명령어</th><th>용도</th></tr>
<tr><td><code>kubectl get pods -A | grep -v Running</code></td><td>비정상 파드</td></tr>
<tr><td></td><td></td></tr>
</tbody></table>
<h3>에스컬레이션</h3>
<blockquote><p>1차: / 2차: / 비상 연락:</p></blockquote>`.trim(),
  },
  {
    id: 'study-notes',
    label: '스터디 정리',
    description: '학습 주제 정리 — 요약·개념·실습·참고·TODO',
    html: `
<h2>스터디 정리</h2>
<p><strong>주제:</strong>  ·  <strong>날짜:</strong> </p>
<h3>핵심 요약</h3>
<ul><li></li></ul>
<h3>개념 정리</h3>
<p></p>
<h3>실습 / 명령</h3>
<pre><code>// 실습 명령/코드</code></pre>
<h3>참고 링크</h3>
<ul><li></li></ul>
<h3>TODO / 더 볼 것</h3>
<ul data-type="taskList">${TASK('')}</ul>`.trim(),
  },
  {
    id: 'skill-checklist',
    label: '기능별 상세 체크리스트',
    description: '기술별 상세항목 — "설명 가능?" 자가진단 체크(역량 점검)',
    html: `
<h2>기능별 상세 체크리스트 (엔지니어 자가진단)</h2>
<table><tbody>
<tr><th>항목</th><th>내용</th></tr>
<tr><td>파트 / 담당</td><td></td></tr>
<tr><td>대상 기능 / 범위</td><td></td></tr>
<tr><td>작성자</td><td></td></tr>
<tr><td>작성일 / 갱신일</td><td></td></tr>
</tbody></table>
<blockquote><p><strong>체크 기준</strong> — ☑ 체크 = <strong>타인에게 설명 가능</strong> · 미체크 = 보충 필요(학습/실습 예정)</p></blockquote>
<h3>진행 현황 (요약)</h3>
<table><tbody>
<tr><th>기술 분야</th><th>설명 가능 / 전체</th><th>진행률</th><th>보충 필요 항목</th></tr>
<tr><td>Kubernetes</td><td></td><td></td><td></td></tr>
<tr><td>네트워킹 (CNI / Cilium)</td><td></td><td></td><td></td></tr>
<tr><td>인증 / 인가</td><td></td><td></td><td></td></tr>
<tr><td>CI/CD · GitOps</td><td></td><td></td><td></td></tr>
<tr><td>스토리지 · 레지스트리</td><td></td><td></td><td></td></tr>
<tr><td>관측성</td><td></td><td></td><td></td></tr>
</tbody></table>
<h3>Kubernetes</h3>
<ul data-type="taskList">${TASK('클러스터 아키텍처(control plane · etcd · kubelet) 설명')}${TASK('Pod 스케줄링 · 리소스 요청/제한')}${TASK('Service / Ingress / DNS 동작 흐름')}${TASK('롤링 업데이트 · 프로브(readiness/liveness)')}</ul>
<h3>네트워킹 (CNI / Cilium)</h3>
<ul data-type="taskList">${TASK('CNI 개념 · Pod 간 네트워크 흐름')}${TASK('Cilium eBPF 데이터패스 · 네트워크 정책')}${TASK('Service 로드밸런싱 · kube-proxy 대체')}</ul>
<h3>인증 / 인가 (Keycloak / RBAC)</h3>
<ul data-type="taskList">${TASK('OIDC / OAuth2 토큰 흐름')}${TASK('Keycloak Realm · Client · Role 매핑')}${TASK('K8s RBAC(Role / RoleBinding) 설명')}</ul>
<h3>CI/CD · GitOps (Jenkins / ArgoCD)</h3>
<ul data-type="taskList">${TASK('파이프라인 단계(build · test · scan · deploy)')}${TASK('GitOps 동기화 · 드리프트 감지')}${TASK('이미지 태깅 · 롤백 전략')}</ul>
<h3>스토리지 · 레지스트리 (PV/PVC / Nexus / MinIO)</h3>
<ul data-type="taskList">${TASK('PV / PVC / StorageClass 동작')}${TASK('레지스트리(Nexus) 운영 · 미러링')}${TASK('오브젝트 스토리지(MinIO / Ceph) 개념')}</ul>
<h3>관측성 (Prometheus / Grafana / 로깅)</h3>
<ul data-type="taskList">${TASK('PromQL 기본 · 주요 메트릭')}${TASK('알람 규칙 · 임계치 설계')}${TASK('로그 파이프라인 · 대시보드 구성')}</ul>
<h3>분야 추가</h3>
<p>필요한 기술 분야와 상세 항목을 추가하세요. (예: Linux/OS, IaC(Ansible/Helm), 보안, DB …)</p>
<ul data-type="taskList">${TASK('')}${TASK('')}</ul>`.trim(),
  },
  {
    id: 'command-table',
    label: '명령어 관리(표)',
    description: '명령어 · 설명 · 비고 표 — 엑셀처럼 정리',
    html: `
<h2>명령어 관리</h2>
<p><strong>분류:</strong> </p>
<table><tbody>
<tr><th>명령어</th><th>설명</th><th>비고</th></tr>
<tr><td><code></code></td><td></td><td></td></tr>
<tr><td><code></code></td><td></td><td></td></tr>
<tr><td><code></code></td><td></td><td></td></tr>
</tbody></table>`.trim(),
  },
  {
    id: 'meeting',
    label: '회의록',
    description: '안건·논의·결정사항·액션아이템 — 회의 기록 표준',
    html: `
<h2>회의록</h2>
<table><tbody>
<tr><th>항목</th><th>내용</th></tr>
<tr><td>일시</td><td></td></tr>
<tr><td>참석자</td><td></td></tr>
<tr><td>장소 / 링크</td><td></td></tr>
<tr><td>작성자</td><td></td></tr>
</tbody></table>
<h3>안건</h3>
<ol><li></li></ol>
<h3>논의 내용</h3>
<p></p>
<h3>결정 사항</h3>
<ul><li></li></ul>
<h3>액션 아이템</h3>
<ul data-type="taskList">${TASK('담당 / 기한 — 할 일')}${TASK('담당 / 기한 — 할 일')}</ul>`.trim(),
  },
  {
    id: 'weekly-report',
    label: '주간 업무 보고',
    description: '이번 주 한 일·진행중·다음 주 계획·이슈/리스크',
    html: `
<h2>주간 업무 보고</h2>
<p><strong>기간:</strong>  ·  <strong>작성자:</strong> </p>
<h3>이번 주 한 일</h3>
<ul data-type="taskList">${TASK('완료 항목')}${TASK('완료 항목')}</ul>
<h3>진행 중</h3>
<ul><li></li></ul>
<h3>다음 주 계획</h3>
<ul data-type="taskList">${TASK('예정 항목')}${TASK('예정 항목')}</ul>
<h3>이슈 / 리스크 / 공유사항</h3>
<table><tbody>
<tr><th>구분</th><th>내용</th><th>대응 / 필요 지원</th></tr>
<tr><td></td><td></td><td></td></tr>
</tbody></table>`.trim(),
  },
  {
    id: 'handover',
    label: '업무 인수인계',
    description: '진행중 업무·미해결 이슈·주의사항·연락처 — 휴가/온콜 핸드오버',
    html: `
<h2>업무 인수인계</h2>
<table><tbody>
<tr><th>항목</th><th>내용</th></tr>
<tr><td>인계자 / 인수자</td><td></td></tr>
<tr><td>기간 / 사유</td><td></td></tr>
<tr><td>비상 연락</td><td></td></tr>
</tbody></table>
<h3>진행 중 업무</h3>
<table><tbody>
<tr><th>업무</th><th>현재 상태</th><th>다음 조치 / 기한</th></tr>
<tr><td></td><td></td><td></td></tr>
</tbody></table>
<h3>미해결 이슈 / 주의사항</h3>
<ul data-type="taskList">${TASK('주의 / 확인 필요 항목')}${TASK('주의 / 확인 필요 항목')}</ul>
<h3>접근 정보 / 참고 링크</h3>
<ul><li></li></ul>`.trim(),
  },
  {
    id: 'decision',
    label: '의사결정 기록(ADR)',
    description: '배경·대안 비교·결정·영향 — 기술/업무 의사결정 기록',
    html: `
<h2>의사결정 기록 (ADR)</h2>
<table><tbody>
<tr><th>항목</th><th>내용</th></tr>
<tr><td>제목</td><td></td></tr>
<tr><td>상태</td><td>(제안 / 채택 / 폐기 / 대체됨)</td></tr>
<tr><td>결정일 / 결정자</td><td></td></tr>
</tbody></table>
<h3>배경 / 문제</h3>
<p></p>
<h3>검토한 대안</h3>
<table><tbody>
<tr><th>대안</th><th>장점</th><th>단점</th></tr>
<tr><td></td><td></td><td></td></tr>
<tr><td></td><td></td><td></td></tr>
</tbody></table>
<h3>결정</h3>
<p></p>
<h3>결과 / 영향</h3>
<ul><li></li></ul>`.trim(),
  },
];
