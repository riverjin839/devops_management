import { useState } from 'react';
import { SidePane } from '@/components/common';
import { StatusDot } from '@/components/common';
import {
  Plus, Pencil, Trash2, Lock, Clock, Settings, ChevronUp, ChevronDown, Play, ScrollText,
} from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'basics' | 'run' | 'sources' | 'logs';
const TABS: { value: Tab; label: string }[] = [
  { value: 'basics', label: '기본 사용법' },
  { value: 'run', label: '실행하기' },
  { value: 'sources', label: '점검 방식' },
  { value: 'logs', label: '로그 · 보관' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="text-sm text-foreground/90 space-y-2">{children}</div>
    </section>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="flex items-center justify-center w-5 h-5 rounded-full border border-border text-[11px] tabular-nums flex-shrink-0 mt-0.5">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}

/** 점검 매트릭스 사용 매뉴얼 — 화면 안에서 바로 읽는 운영 안내. 상세 문서는 docs/CHECK_MATRIX_GUIDE.md. */
export function CheckMatrixHelpPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('basics');

  return (
    <SidePane open={open} onClose={onClose} title="점검 매트릭스 사용법" width="520px">
      <div className="space-y-5 pb-4">
        <div className="flex items-center gap-1 border-b border-border -mx-5 px-5">
          {TABS.map((t) => (
            <button
              key={t.value}
              onClick={() => setTab(t.value)}
              className={`px-2.5 py-1.5 text-xs font-medium border-b-2 transition-colors ${
                tab === t.value
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'basics' && (
          <div className="space-y-6">
            <Section title="기본 구조">
              <p>행은 점검 항목, 열은 등록된 클러스터입니다. 각 셀은 해당 클러스터에서 그 항목의 최신 상태를 보여줍니다.</p>
              <ul className="space-y-1.5 pl-1">
                <li className="flex items-center gap-2"><StatusDot variant="healthy" /> 정상</li>
                <li className="flex items-center gap-2"><StatusDot variant="warning" /> 경고</li>
                <li className="flex items-center gap-2"><StatusDot variant="critical" /> 위험</li>
                <li className="flex items-center gap-2"><StatusDot variant="pending" /> 대기(연결 안 됨 등)</li>
                <li className="flex items-center gap-2">
                  <span className="text-muted-foreground/50 text-xs w-2 text-center">—</span>
                  아직 한 번도 실행되지 않은 셀
                </li>
              </ul>
            </Section>

            <Section title="셀 클릭 — 상세 보기">
              <p>셀을 클릭하면 탭 3개짜리 상세가 열립니다.</p>
              <ul className="list-disc pl-5 space-y-1">
                <li><b>추이 · 이력</b> — 기간별(7/30/90일) 차트, 상태가 바뀐 시점, 수동 입력 폼, 이 클러스터에서의 cron</li>
                <li><b>실행 방식</b> — 이 점검이 대상 클러스터에서 <b>실제로 수행하는 명령</b>과 단계, 적용되는 설정값</li>
                <li><b>수행 로그</b> — 이 셀의 모든 수행 기록(자동·수동)과 각 수행의 명령·출력</li>
              </ul>
            </Section>

            <Section title="항목(행) 관리">
              <ul className="space-y-2">
                <li className="flex items-start gap-2">
                  <Plus className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span>카드 상단 <b>"항목 추가"</b>로 새 점검 항목을 등록합니다. 자동 실행(Deep Check/Addon) 또는
                    자동 체커가 없는 대상(AiStor, NFS, N/W 스위치 등)을 위한 <b>수동 입력</b> 타입 중 선택합니다.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Pencil className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span>행에 마우스를 올리면 나타나는 연필 아이콘으로 이름/설명/단위/실행 방식을 수정합니다.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Trash2 className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span>휴지통 아이콘으로 삭제(이력도 함께 삭제됩니다).</span>
                </li>
                <li className="flex items-start gap-2">
                  <Lock className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span><b>잠금 아이콘</b>이 붙은 항목(예: K8S API-SERVER 응답시간)은 클러스터 전체 상태 계산에
                    쓰이는 시스템 항목이라 삭제할 수 없습니다.</span>
                </li>
                <li className="flex items-start gap-2">
                  <span className="flex flex-col -my-0.5 flex-shrink-0 text-muted-foreground">
                    <ChevronUp className="w-3 h-3" /><ChevronDown className="w-3 h-3" />
                  </span>
                  <span>행 이름 옆 위/아래 화살표로 순서를 바꿉니다.</span>
                </li>
              </ul>
            </Section>

            <Section title="클러스터(열) cron">
              <p className="flex items-start gap-2">
                <Clock className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>각 클러스터 열 헤더의 시계 배지를 클릭하면, 핵심 항목(API 서버 응답시간 등)을 이
                  클러스터에서 언제 자동 점검할지 cron 표현식으로 설정할 수 있습니다. 이 값을 비워두면 해당
                  클러스터는 자동 점검되지 않습니다. cron 은 최소 5분 간격 이상이어야 합니다.</span>
              </p>
            </Section>
          </div>
        )}

        {tab === 'run' && (
          <div className="space-y-6">
            <Section title="지금 실행하는 3가지 단위">
              <p>cron 을 기다리지 않고 바로 돌릴 수 있습니다. 실행 권한은 operator 이상입니다.</p>
              <ul className="space-y-2.5">
                <li className="flex items-start gap-2">
                  <Play className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span><b>셀 1개</b> — 셀을 클릭해 열린 상세의 우측 상단 <b>"지금 실행"</b>. 동기 실행이라
                    결과가 바로 나오고, 끝나면 그 수행이 "수행 로그" 탭에 펼쳐집니다.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Play className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span><b>클러스터(K8s) 단위</b> — 클러스터 열 헤더 이름 옆 <b>▶</b> 버튼. 그 클러스터의 모든
                    자동 점검 항목을 한 번에 큐잉합니다.</span>
                </li>
                <li className="flex items-start gap-2">
                  <Play className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                  <span><b>공통 점검 항목 단위</b> — 행에 마우스를 올리면 나오는 <b>▶</b> 버튼. 그 항목을 등록된
                    모든 클러스터에 대해 한 번에 큐잉합니다.</span>
                </li>
              </ul>
            </Section>

            <Section title="일괄 실행은 큐잉 방식입니다">
              <p>클러스터/항목 단위 실행은 셀마다 독립 작업으로 큐에 들어갑니다. 느린 클러스터 하나가 나머지
                점검을 막지 않도록 하기 위한 것이고, 대신 결과는 즉시가 아니라 순차적으로 채워집니다.</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>실행을 누르면 <b>수행 로그 패널</b>이 그 일괄 실행만 필터해서 열리고 3초마다 갱신됩니다.</li>
                <li>상태는 <b>대기열 → 실행 중 → 완료/실패/건너뜀</b> 순으로 바뀝니다.</li>
                <li><b>건너뜀</b>은 그 클러스터에 실행 대상(점검 정의 또는 애드온)이 없다는 뜻입니다 — 셀이 왜
                  계속 "—" 인지의 답이 대부분 여기 있습니다.</li>
                <li>Celery 워커가 떠 있지 않으면 큐잉 자체가 실패하고 해당 수행이 <b>실패</b>로 기록됩니다.</li>
              </ul>
            </Section>

            <Section title="실행 전에 무엇이 도는지 확인하기">
              <p>셀 상세의 <b>"실행 방식"</b> 탭에 이 점검이 대상 클러스터에서 실제로 수행하는 명령이 순서대로
                나열됩니다. kubectl 실행 / K8s API 호출 / HTTP 프로브 / SSH / PEP DB 조회를 배지로 구분하고,
                대상에 변경을 일으킬 수 있는 명령에는 <b>변경</b> 배지가 붙습니다.</p>
            </Section>
          </div>
        )}

        {tab === 'sources' && (
          <div className="space-y-6">
            <Section title="Deep Check — 점검 정의를 실행">
              <p>PEP 에 내장된 점검기(인증서 만료, etcd 단편화, PVC, CoreDNS, OOM 등)를 실행합니다.</p>
              <ol className="space-y-1.5">
                <Step n={1}>
                  행의 <b>실행 방식</b>을 <code className="font-mono text-xs">Deep Check</code> 로 두고, 점검 종류
                  (check_type)를 고릅니다. 이 값은 <b>논리 키</b>일 뿐입니다.
                </Step>
                <Step n={2}>
                  실행 시점에 <b>이 클러스터 전용 점검 정의</b>를 먼저 찾고, 없으면 <b>글로벌 정의</b>로 넘어갑니다.
                  둘 다 없으면 그 셀은 실행되지 않고 <b>건너뜀</b>으로 남습니다.
                </Step>
                <Step n={3}>
                  임계값(thresholds)과 파라미터(params)는 <b>점검 정의</b>에 저장된 값이 쓰입니다 — 매트릭스 행에는
                  임계값이 없습니다. 값 변경은 운영 점검(Ops Checks) 화면에서 합니다.
                </Step>
                <Step n={4}>
                  cron 은 두 곳에서 올 수 있습니다 — 이 화면의 <b>셀 cron</b>(항목 × 클러스터), 그리고 점검 정의
                  자체의 <b>schedule_cron</b>. 둘 다 최소 5분 간격입니다.
                </Step>
              </ol>
              <p className="text-xs text-muted-foreground">
                커스텀 타입(커스텀 HTTP/kubectl/PromQL)은 같은 check_type 으로 여러 정의를 만드는 템플릿형이라
                매트릭스 기본 행으로 시드되지 않습니다.
              </p>
            </Section>

            <Section title="Addon — 등록된 애드온을 헬스 체크">
              <p>클러스터에 등록해 둔 애드온(etcd, ArgoCD, Nexus, Jenkins, Keycloak, 시스템 파드 등)의 상태를 봅니다.</p>
              <ol className="space-y-1.5">
                <Step n={1}>
                  행의 실행 방식을 <code className="font-mono text-xs">Addon</code> 으로 두고 애드온 <b>타입</b>을 고릅니다.
                </Step>
                <Step n={2}>
                  실행 시점에 <b>같은 타입 + 같은 클러스터</b>인 애드온 인스턴스를 찾습니다. 그 클러스터에 해당
                  애드온이 등록돼 있지 않으면 <b>건너뜀</b>입니다.
                </Step>
                <Step n={3}>
                  접속 주소·인증정보는 애드온의 <code className="font-mono text-xs">config</code> 에서 옵니다
                  (비어 있으면 클러스터 내부 기본 주소). 실행 방식 탭에서 실제로 어떤 URL 을 두드리는지 확인할 수 있습니다.
                </Step>
                <Step n={4}>
                  결과는 매트릭스 셀과 함께 <b>애드온 자체의 상태</b>도 갱신하며, 그 값이 클러스터 전체 상태
                  재계산에 반영됩니다.
                </Step>
              </ol>
            </Section>

            <Section title="수동 입력 — 자동 체커가 없는 대상">
              <p>NAS 콘솔, 네트워크 스위치, 외주 점검 결과처럼 PEP 가 직접 찌를 수 없는 대상을 같은 매트릭스에서
                함께 관리합니다.</p>
              <ol className="space-y-1.5">
                <Step n={1}>
                  항목 추가에서 실행 방식을 <code className="font-mono text-xs">수동 입력</code> 으로 만듭니다.
                  점검 종류/애드온 타입은 고르지 않습니다.
                </Step>
                <Step n={2}>
                  값을 넣을 셀을 클릭하고 <b>추이 · 이력</b> 탭 아래 <b>값 입력</b>에서 상태(정상/경고/위험/대기),
                  수치(선택), 메모(선택)를 저장합니다.
                </Step>
                <Step n={3}>
                  입력한 값도 자동 점검과 똑같이 이력에 쌓여 추이 차트·변경 이력이 동일하게 동작하고,
                  <b>누가 언제 넣었는지</b>가 수행 로그에 <b>수동 입력</b>으로 남습니다.
                </Step>
                <Step n={4}>
                  자동 실행이 없으므로 cron 을 설정할 수 없고, ▶ 실행 버튼도 나오지 않습니다. 값을 넣기 전까지
                  셀은 "—" 로 남습니다.
                </Step>
              </ol>
            </Section>

            <Section title="핵심 항목 (잠금)">
              <p>API 서버 응답시간 행은 <b>DailyChecker 를 통째로 한 번 실행</b>한 결과 중 응답시간만 셀에 투영한
                것입니다. 이 실행이 클러스터 전체 상태(사이드바 색)를 갱신하는 유일한 경로라서, 항목별 cron 이
                아니라 <b>클러스터 열의 cron</b> 으로 스케줄하고 삭제할 수 없습니다.</p>
            </Section>
          </div>
        )}

        {tab === 'logs' && (
          <div className="space-y-6">
            <Section title="수행 로그">
              <p className="flex items-start gap-2">
                <ScrollText className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>카드 상단 <b>"수행 로그"</b>에서 모든 수행을 한 줄기로 봅니다 — cron 자동 실행, 셀/클러스터/
                  항목 수동 실행, 수동 입력까지 트리거별로 필터할 수 있습니다. 특정 셀만 보려면 셀 상세의
                  <b> 수행 로그</b> 탭을 쓰세요.</span>
              </p>
              <p>수행 하나를 클릭하면 이렇게 남습니다.</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>트리거 종류와 <b>실행한 사람</b>, 큐잉/시작/종료 시각과 소요 시간</li>
                <li><b>실행 단계</b> 타임라인 — 어느 단계에서 성공/실패했는지</li>
                <li><b>실행된 명령</b> — 실제로 나간 kubectl 명령, 종료 코드, stdout/stderr 발췌</li>
                <li>그 수행 시점의 <b>실행 계획</b>과 체커가 돌려준 결과 상세</li>
              </ul>
              <p className="text-xs text-muted-foreground">
                K8s API(SDK)만 쓰는 점검은 명령 목록이 비어 있을 수 있습니다 — 계측 대상이 kubectl 실행이기
                때문입니다. 어떤 호출이 나가는지는 실행 계획에서 확인하세요.
              </p>
            </Section>

            <Section title="추이 이력과 수행 로그의 차이">
              <p><b>추이 · 이력</b>은 "값이 어떻게 변해왔나", <b>수행 로그</b>는 "언제 무엇을 실행했나"입니다.
                대기열·건너뜀처럼 판정이 없는 수행은 로그에만 남고 차트를 오염시키지 않습니다.</p>
            </Section>

            <Section title="이력 보관 설정">
              <p className="flex items-start gap-2">
                <Settings className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>카드 우측 상단 톱니바퀴에서 보관 일수를 설정합니다. 값 이력과 수행 로그 모두 이 설정을
                  따르며, 기간이 지난 기록은 매일 자동으로 정리됩니다. 수행 로그는 명령 출력을 담아 값 이력보다
                  행이 크니 DB 용량을 고려해 설정하세요.</span>
              </p>
            </Section>
          </div>
        )}
      </div>
    </SidePane>
  );
}
