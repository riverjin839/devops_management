/**
 * 화면별 사용 매뉴얼 원천 — `/manual/:topic` 이 렌더한다.
 *
 * 화면 안에는 "무엇을 하는 곳인지"를 설명하는 문장을 두지 않고, 헤더의 「사용법」 링크(`PageHeader` 의 `manual`)로
 * 여기 연결한다. 화면에 남기는 것은 라벨·오류·위험 경고(결정에 필요한 한 줄)뿐이다.
 * 새 매뉴얼은 `MANUALS` 에 항목을 추가하고 해당 화면 `PageHeader` 에 `manual="<key>"` 를 준다.
 */
export interface ManualNote {
  kind: 'tip' | 'warn';
  text: string;
}

export interface ManualSection {
  id: string;
  title: string;
  /** 문단 */
  body?: string[];
  /** 번호 순서가 있는 절차 */
  steps?: string[];
  /** 순서 없는 목록 */
  items?: string[];
  notes?: ManualNote[];
}

export interface ManualTopic {
  key: string;
  title: string;
  /** 매뉴얼이 설명하는 화면 경로(목차의 「화면 열기」 링크) */
  route: string;
  /** 목차·헤더 한 줄 요약 */
  summary: string;
  sections: ManualSection[];
}

export const MANUALS: ManualTopic[] = [
  {
    key: 'k9s',
    title: 'k9s 콘솔',
    route: '/k9s',
    summary: '컨트롤 플레인 서버의 k9s 를 SSH 로 실행해 웹 터미널로 엽니다.',
    sections: [
      {
        id: 'prereq',
        title: '사전 조건',
        items: [
          '대상 서버에 k9s 가 설치되어 있어야 합니다.',
          '접속 계정의 ~/.kube/config 로 클러스터에 접근할 수 있어야 합니다.',
          'operator 이상 권한이 필요합니다(viewer 는 버튼이 비활성화됩니다).',
        ],
      },
      {
        id: 'connect',
        title: '연결하기',
        steps: [
          '왼쪽에서 클러스터를 고릅니다.',
          '「대상」에서 컨트롤 플레인 노드를 고르거나, 목록에 없으면 「호스트 직접 입력」에 주소를 적습니다. 직접 입력한 값이 우선합니다.',
          '사용자를 확인하고, 「인증 · 실행」에서 비밀번호 또는 개인키(PEM)를 입력합니다.',
          '「연결」은 이 화면 위의 창으로, 「별도 창으로 연결」은 별도 브라우저 창으로 k9s 를 엽니다.',
        ],
        notes: [
          { kind: 'tip', text: '포트(기본 22)와 네임스페이스는 「고급」을 펼쳐 바꿉니다. 네임스페이스를 비우면 k9s 기본값을 씁니다.' },
          { kind: 'tip', text: '호스트·계정·포트·인증 방식·네임스페이스는 클러스터별로 이 브라우저에 기억됩니다. 비밀번호와 개인키는 저장하지 않습니다.' },
        ],
      },
      {
        id: 'readonly',
        title: '읽기 전용과 보호 레벨',
        body: [
          '읽기 전용이 켜져 있으면 k9s 를 --readonly 로 실행해 조회만 가능합니다. 꺼면 리소스 수정·삭제·스케일·셸 진입이 가능해집니다.',
          '운영레벨이 「보호」인 클러스터(기본 production·dr)는 읽기 전용이 기본으로 켜져 있고, 연결 전에 대상·계정을 확인하는 창이 뜹니다. 운영레벨이 지정되지 않았거나 아직 불러오는 중이어도 보호 레벨로 취급합니다.',
        ],
        notes: [
          { kind: 'warn', text: '보호 레벨 클러스터에서 읽기 전용을 끄면 확인 창이 한 번 더 뜹니다. 가능하면 전용 운영 계정으로 접속하세요(root 접속 시 경고가 표시됩니다).' },
        ],
      },
      {
        id: 'session',
        title: '세션 사용과 종료',
        items: [
          '세션은 최대 1시간이며, 종료 5분 전에 터미널에 경고가 출력됩니다.',
          '다른 메뉴로 이동하면 세션이 끊깁니다. 이동하며 계속 쓰려면 터미널 창 상단바의 「새 창으로 빼기」로 별도 브라우저 창에 옮기세요.',
          '창 상단바를 끌어 이동하고, 우하단 모서리로 크기를 조절합니다.',
          '세션 중 클러스터를 바꾸면 SSH 세션과 실행 중인 k9s 가 종료됩니다.',
        ],
      },
      {
        id: 'log',
        title: '실행 로그',
        body: [
          '연결을 시도할 때마다 화면 상단의 실행 로그 패널에 단계(웹소켓 연결·SSH 접속·첫 응답·종료 코드)가 실시간으로 쌓입니다. 「로그 보기」 옵션으로 패널 표시 여부를 정하며, 선택은 기억됩니다.',
          '연결 중에는 「중단」으로 시도를 취소할 수 있고, 15초 넘게 응답이 없으면 지연 경고가 표시됩니다.',
        ],
      },
      {
        id: 'trouble',
        title: '접속이 안 될 때',
        items: [
          '첫 응답 전에 종료되면 접속 실패로 처리되어 폼으로 돌아옵니다. 입력한 값은 유지되고 사유가 화면 위에 표시됩니다.',
          '인증 실패: 계정·비밀번호·개인키(줄바꿈 포함 전체)를 확인합니다.',
          '연결은 되는데 k9s 가 뜨지 않으면: 서버에 k9s 설치 여부와 ~/.kube/config 를 확인합니다.',
          '기능 자체가 꺼져 있을 수 있습니다(서버 환경변수 PEP_K9S_SSH_ENABLED=false).',
        ],
      },
    ],
  },
  {
    key: 'k8s-rbac',
    title: 'K8s 접근 권한',
    route: '/k8s',
    summary: 'ServiceAccount·Role·Binding 을 발급하고 kubeconfig 를 내려받습니다.',
    sections: [
      {
        id: 'flow',
        title: '발급 흐름',
        steps: [
          '왼쪽에서 클러스터를 고르고 「액세스 발급」 탭을 엽니다.',
          '권한 프리셋을 고릅니다. 고른 뒤 아래 「권한 규칙」 표에서 그대로 고칠 수 있습니다.',
          '「대상」에서 ServiceAccount 이름과 네임스페이스를 정합니다.',
          '바인딩 방식과 토큰 만료 기간을 정합니다.',
          '「모의 실행」으로 아무것도 만들지 않고 단계 로그를 확인한 뒤, 「발급 실행」으로 실제 적용합니다.',
        ],
        notes: [
          { kind: 'tip', text: '발급이 끝나면 kubeconfig 가 화면에 표시됩니다. 닫기 전까지는 탭·뷰를 옮겨도 유지되지만, 서버에는 저장되지 않습니다.' },
        ],
      },
      {
        id: 'presets',
        title: '권한 프리셋',
        items: [
          '개발자 배포 + 로그(권장, 위험 중간): 자기 네임스페이스에 배포하고 로그·이벤트 조회, exec/port-forward. 노드·네임스페이스 같은 클러스터 스코프 리소스는 불가.',
          '조회 전용(위험 낮음): 쓰기 권한이 전혀 없습니다. 장애 확인·모니터링용.',
          '디버깅(위험 중간): 조회 전용에 exec/port-forward 를 더합니다. exec 는 컨테이너 안의 파일·환경변수를 볼 수 있어 실질 권한이 큽니다.',
          '네임스페이스 관리자(위험 높음): 해당 네임스페이스 안 모든 리소스 전권. RBAC 변경까지 가능하므로 팀 리드에게만 부여합니다.',
          '클러스터 전체 조회(위험 중간): 노드·스토리지클래스 등 클러스터 스코프까지 읽기. secrets 는 일부러 제외했습니다.',
        ],
      },
      {
        id: 'binding',
        title: '바인딩 방식',
        items: [
          'ClusterRole + 네임스페이스별 RoleBinding(권장): 권한 정의는 하나, 네임스페이스마다 붙입니다. 권한은 바인딩된 네임스페이스로만 한정됩니다.',
          '네임스페이스별 Role + RoleBinding: 네임스페이스마다 권한을 다르게 줄 때, 또는 ClusterRole 생성 권한이 없을 때.',
          'ClusterRole + ClusterRoleBinding(클러스터 전역): 앞으로 생길 네임스페이스까지 포함해 모든 곳에 걸립니다. 조회 전용이 아니면 권장하지 않습니다.',
        ],
      },
      {
        id: 'token',
        title: '토큰 만료',
        body: [
          '기본은 7일(1·7·30·90일 선택)이며 만료되면 자동으로 무효화됩니다. 「만료 없음」은 Secret 토큰으로 발급되어 회수 전까지 유효합니다.',
        ],
        notes: [
          { kind: 'warn', text: 'kubeconfig 를 건넨 뒤에는 토큰을 되돌릴 수 없습니다. 무효화하려면 ServiceAccount 탭에서 액세스를 회수하세요.' },
        ],
      },
      {
        id: 'risk',
        title: '위험 확인 창',
        body: [
          '클러스터 전역 바인딩, 높은 위험 프리셋, 만료 없음 토큰처럼 범위가 넓은 발급은 사유를 보여 주는 확인 창이 뜨고, ServiceAccount 이름을 직접 입력해야 진행됩니다.',
        ],
      },
      {
        id: 'tabs',
        title: '다른 탭',
        items: [
          'ServiceAccount: 목록 조회, 액세스 검토, 액세스 회수.',
          'Role / Binding: 기존 Role·ClusterRole·Binding 을 직접 편집.',
          '액세스 검토: 특정 ServiceAccount 가 실제로 할 수 있는 동작을 SubjectAccessReview 로 확인합니다.',
        ],
      },
      {
        id: 'perm',
        title: '권한',
        body: ['발급·편집·회수는 operator 이상입니다. viewer 는 조회만 가능하며 버튼은 사유와 함께 비활성화됩니다. 테넌트에 바인딩된 클러스터는 operate 멤버만 변경할 수 있습니다.'],
      },
    ],
  },
];

export const MANUAL_BY_KEY: Record<string, ManualTopic> = Object.fromEntries(
  MANUALS.map((m) => [m.key, m]),
);
