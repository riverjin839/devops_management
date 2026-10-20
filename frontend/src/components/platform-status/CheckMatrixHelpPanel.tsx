import { useState } from 'react';
import { SidePane, StatusDot } from '@/components/common';
import {
  Plus, Pencil, Trash2, Lock, Clock, Settings, GripVertical, Play, ScrollText, Loader2,
  AlertTriangle, XCircle, SlidersHorizontal, PauseCircle, History,
} from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

type Tab = 'start' | 'read' | 'run' | 'manage' | 'sources';
const TABS: { value: Tab; label: string }[] = [
  { value: 'start', label: '빠른 시작' },
  { value: 'read', label: '화면 읽기' },
  { value: 'run', label: '실행 · 로그' },
  { value: 'manage', label: '항목 · 주기' },
  { value: 'sources', label: '점검 방식' },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold text-muted-foreground">{title}</h3>
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

function Row({ icon, children }: { icon: React.ReactNode; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 flex-shrink-0 text-muted-foreground">{icon}</span>
      <span>{children}</span>
    </li>
  );
}

/** 점검 매트릭스 사용 매뉴얼 — 화면 안에서 바로 읽는 운영 안내. 상세 문서는 docs/CHECK_MATRIX_GUIDE.md. */
export function CheckMatrixHelpPanel({ open, onClose }: Props) {
  const [tab, setTab] = useState<Tab>('start');

  return (
    <SidePane open={open} onClose={onClose} title="점검 매트릭스 사용법" width="540px">
      <div className="space-y-5 pb-4">
        <div role="tablist" aria-label="도움말" className="flex items-center gap-1 border-b border-border -mx-5 px-5 overflow-x-auto">
          {TABS.map((t) => (
            <button
              key={t.value}
              role="tab"
              aria-selected={tab === t.value}
              onClick={() => setTab(t.value)}
              className={`px-2.5 py-1.5 text-xs font-medium border-b-2 whitespace-nowrap transition-colors ${
                tab === t.value
                  ? 'border-primary text-foreground'
                  : 'border-transparent text-muted-foreground hover:text-foreground'
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        {tab === 'start' && (
          <div className="space-y-6">
            <Section title="이 화면은">
              <p>행은 <b>점검 항목</b>, 열은 <b>클러스터</b>, 셀은 그 클러스터에서 그 항목의 <b>가장 최근 판정</b>입니다.
                항목은 영역(K8s·네트워크·스토리지·OS·애플리케이션)별로 묶이며, 경고·위험이 있는 영역은 처음부터 펼쳐집니다.</p>
            </Section>
            <Section title="처음 5분">
              <ol className="space-y-1.5">
                <Step n={1}>영역 머리글의 빨강·주황 숫자로 <b>문제가 있는 영역</b>부터 봅니다.</Step>
                <Step n={2}>빨간 셀을 누르면 <b>추이 · 이력 / 실행 주기 / 실행 계획 / 실행 기록</b> 탭이 열립니다.
                  「실행 기록」 에서 무슨 명령이 나갔고 왜 실패했는지 확인합니다.</Step>
                <Step n={3}>조치 후 상세 우측 상단 <b>「지금 실행」</b> 으로 다시 확인합니다. 실행 로그가 그 자리에서 실시간으로 갱신됩니다.</Step>
                <Step n={4}>자동으로 돌게 하려면 「실행 주기」 탭에서 주기를 고릅니다(프리셋 제공, 최소 5분).</Step>
                <Step n={5}>새 점검은 상단 <b>「항목 추가」</b> — 점검 선택 → 설정 → 테스트·저장 3단계입니다.</Step>
              </ol>
            </Section>
            <Section title="권한">
              <p>조회는 로그인 사용자 누구나, 실행·추가·수정·주기 변경은 <b>operator 이상</b>입니다. 테넌트에 묶인 클러스터는
                그 테넌트에서 <b>실행 권한(operate)</b>을 받은 사용자만 실행할 수 있습니다 — 권한이 없으면 버튼이 흐리게
                보이고 마우스를 올리면 사유가 나옵니다.</p>
            </Section>
          </div>
        )}

        {tab === 'read' && (
          <div className="space-y-6">
            <Section title="셀 기호">
              <ul className="space-y-1.5 pl-1">
                <Row icon={<StatusDot variant="healthy" />}>정상</Row>
                <Row icon={<span className="inline-flex items-center gap-1"><StatusDot variant="warning" /><AlertTriangle className="w-3 h-3" /></span>}>경고 — 색과 모양을 함께 씁니다</Row>
                <Row icon={<span className="inline-flex items-center gap-1"><StatusDot variant="critical" /><XCircle className="w-3 h-3" /></span>}>위험</Row>
                <Row icon={<StatusDot variant="pending" />}>대기 — 판정 보류(연결 안 됨 등)</Row>
                <Row icon={<span className="text-xs w-3 text-center">—</span>}>아직 결과 없음. 마우스를 올리면 이유(주기 대기·수동 미입력 등)가 나옵니다</Row>
                <Row icon={<Loader2 className="w-3 h-3 text-status-info" />}>지금 실행 중이거나 대기열에 있음</Row>
                <Row icon={
                  <span className="inline-flex items-center gap-0.5 px-1 rounded-md border border-dashed border-muted-foreground/70 text-xs font-medium">
                    정상<History className="w-3 h-3 text-muted-foreground" aria-hidden="true" />
                  </span>
                }>점선 테두리 + 시계 = <b>오래된 결과</b> — 주기의 2배(주기가 없으면 7일)를 넘겼습니다</Row>
                <Row icon={<XCircle className="w-2.5 h-2.5 text-status-critical" />}>셀 왼쪽 아래 표식 = <b>최근 실행이 실패</b>해 값이 갱신되지 않았습니다(값은 그 전 결과)</Row>
              </ul>
              <p className="text-xs text-muted-foreground">셀의 <b>숫자</b>는 점검의 대표값입니다 — 인증서는 잔여일, 프로브는 실패율(%),
                이벤트류는 건수. 숫자가 없으면 판정 라벨(정상/경고…)을 보여줍니다.</p>
            </Section>
            <Section title="클러스터 열 머리글">
              <ul className="space-y-1.5">
                <Row icon={<StatusDot variant="healthy" />}>이름 옆 점 = 클러스터 종합 상태. 이름을 누르면 원인 목록이 있는 클러스터 상세로 갑니다.</Row>
                <Row icon={<Clock className="w-3.5 h-3.5" />}>배지 = 핵심 점검 주기(예: 「매일 09:15, 13:15, 18:15」). 점선은 주기 없음,
                  <PauseCircle className="inline w-3 h-3 mx-0.5" />는 주기는 있지만 꺼짐입니다. 눌러서 바꿉니다.</Row>
                <Row icon={<Play className="w-3.5 h-3.5" />}>「전체」(재생 아이콘) = 이 클러스터의 모든 자동 점검을 지금 실행.</Row>
              </ul>
            </Section>
            <Section title="행(항목) 표시">
              <ul className="space-y-1.5">
                <Row icon={<Lock className="w-3.5 h-3.5" />}>핵심 항목 — 클러스터 상태 계산에 쓰여 삭제할 수 없습니다(비활성으로 숨기기만 가능).</Row>
                <Row icon={<span className="text-[11px] border border-border rounded px-1">kubectl</span>}>실행 기술 배지 — 이 점검이 무엇으로 도는지(K8s API/kubectl/HTTP/SSH/Ansible/수동).</Row>
                <Row icon={<span className="text-[11px] border border-border rounded px-1">중복</span>}>같은 대상(예: etcd)을 다른 실행 기술로도 점검하는 항목이 있다는 뜻입니다.</Row>
                <Row icon={<span className="text-[11px] border border-border rounded px-1">꺼짐</span>}>비활성 항목 — 자동·일괄 실행에서 빠집니다. 기본으로 숨겨지며 표시 설정에서 보이게 할 수 있습니다.</Row>
              </ul>
            </Section>
            <Section title="표시 설정">
              <p className="flex items-start gap-2">
                <SlidersHorizontal className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>툴바의 조절 아이콘 — 행 높이, 범례 표시, <b>실행 시 로그 자동 열기</b>, 비활성 항목 표시, 영역 모두 펼치기/접기, 열 너비 초기화.
                  열 너비는 머리글 오른쪽 끝을 드래그(더블클릭 = 자동 맞춤).</span>
              </p>
              <p className="flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>툴바 <b>「문제만」</b> — 경고·위험 셀이 있거나 최근 실행이 실패한 항목만 남깁니다.
                  <b> 「표 / 목록」</b> — 목록은 영역 → 항목 → 클러스터별 칩의 1열 보기로, 좁은 화면(1024px 미만)에서는 처음부터 목록으로 열립니다.</span>
              </p>
            </Section>
          </div>
        )}

        {tab === 'run' && (
          <div className="space-y-6">
            <Section title="지금 실행하는 3가지 단위">
              <p>모두 확인창을 거치고, 이미 대기·실행 중인 셀은 다시 큐에 넣지 않습니다(연타·중복 방지).</p>
              <ul className="space-y-2.5">
                <Row icon={<Play className="w-4 h-4" />}><b>셀 1개</b> — 셀에 마우스를 올리면 나오는 재생 아이콘, 또는 셀 상세 우측 상단 「지금 실행」.</Row>
                <Row icon={<Play className="w-4 h-4" />}><b>클러스터 전체</b> — 열 머리글의 「전체」(재생 아이콘). 그 클러스터의 활성 자동 점검 항목 전부.</Row>
                <Row icon={<Play className="w-4 h-4" />}><b>항목 전체</b> — 행의 「전 클러스터」(재생 아이콘). 실행 권한이 있는 클러스터 전부.</Row>
              </ul>
            </Section>
            <Section title="실시간 실행 로그">
              <p>실행은 큐에 들어간 뒤 워커가 하나씩 처리합니다. 실행하면 <b>실행 로그 창</b>이 열려 진행을 그대로 보여줍니다.</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>상태는 <b>대기열 → 실행 중 → 완료/실패/건너뜀</b> 순으로 2~3초마다 갱신됩니다.</li>
                <li>「실행 로그」 에는 대기열 등록·실행 시작·실행 대상·단계·판정이 시각과 함께 줄 단위로 쌓입니다.</li>
                <li>그 아래 <b>실행된 명령</b>(종료 코드·stdout/stderr), <b>그때의 실행 계획</b>, <b>결과 상세</b>가 이어집니다.
                  실패·위험이면 사유 상자와 결과 상세가 자동으로 펼쳐집니다.</li>
                <li><b>건너뜀</b> = 그 클러스터에 실행 대상(점검 정의·애드온·같은 이름의 배치잡/플레이북)이 없습니다.</li>
              </ul>
              <p className="text-xs text-muted-foreground">로그 창을 자동으로 열지 않으려면 표시 설정에서 「실행하면 실행 로그 창 자동으로 열기」 를 끄세요 —
                그래도 실행 알림의 <b>「로그 보기」</b> 로 언제든 열 수 있습니다.</p>
            </Section>
            <Section title="모든 실행 기록">
              <p className="flex items-start gap-2">
                <ScrollText className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>툴바의 「실행 로그」 는 자동(cron)·셀·클러스터·항목·수동 입력을 한 줄기로 보여주고 트리거별로 거를 수 있습니다.
                  지금 돌고 있는 건수가 버튼 옆에 표시됩니다. 특정 셀만 보려면 셀 상세의 「실행 기록」 탭을 쓰세요.</span>
              </p>
            </Section>
            <Section title="무엇이 실행되는지 먼저 보기">
              <p>셀 상세의 「실행 계획」 탭에 대상 클러스터로 실제로 나가는 명령이 순서대로 나옵니다. 대상에 변경을 일으킬 수 있는
                명령에는 <b>변경</b> 배지가 붙습니다. 비밀번호·토큰 같은 값은 ******** 로 가려집니다.</p>
            </Section>
          </div>
        )}

        {tab === 'manage' && (
          <div className="space-y-6">
            <Section title="항목 추가 — 3단계">
              <ol className="space-y-1.5">
                <Step n={1}><b>점검 선택</b> — 검색해서 고르거나 「직접 만들기」(새 플레이북·커스텀 HTTP/kubectl/PromQL).</Step>
                <Step n={2}><b>설정</b> — 이름과 임계값·파라미터. 각 값의 뜻이 입력칸 아래에 적혀 있습니다.
                  「이 항목만 따로 설정」 을 켜면 같은 점검 종류를 쓰는 다른 항목과 설정을 공유하지 않습니다.</Step>
                <Step n={3}><b>테스트 · 저장</b> — 클러스터 하나에 저장 없이 한 번 돌려보고 로그를 확인한 뒤 저장(테스트는 건너뛸 수 있음).</Step>
              </ol>
            </Section>
            <Section title="항목 관리">
              <ul className="space-y-2">
                <Row icon={<Pencil className="w-4 h-4" />}>연필 — 이름·실행 소스·임계값/파라미터·영역·색·활성 여부 수정.</Row>
                <Row icon={<Trash2 className="w-4 h-4" />}>휴지통 — 삭제(셀 값·이력·주기·실행 기록 함께 삭제). 잠시 빼 두려면 비활성으로 바꾸세요.</Row>
                <Row icon={<GripVertical className="w-4 h-4" />}>그립 — 드래그하거나 키보드 ↑↓ 로 <b>같은 영역 안에서</b> 순서 변경. 다른 영역으로 옮기려면 항목의 영역을 바꿉니다.</Row>
                <Row icon={<Plus className="w-4 h-4" />}>항목 이름을 누르면 <b>항목 상세</b> — 정의·테스트·클러스터별 실행 주기·실행 계획·실행 기록·추이를 한 화면에서 봅니다.</Row>
              </ul>
            </Section>
            <Section title="실행 주기(cron)">
              <ul className="space-y-1.5">
                <Row icon={<Clock className="w-4 h-4" />}><b>셀 주기</b> — 셀 상세 「실행 주기」 탭 또는 항목 상세 「실행 주기」 탭(클러스터별 한 표).</Row>
                <Row icon={<Clock className="w-4 h-4" />}><b>핵심 점검 주기</b> — 클러스터 열 머리글의 배지(클러스터 단위).</Row>
              </ul>
              <p className="text-xs text-muted-foreground">입력하면 바로 사람 말 설명과 <b>다음 실행 3회</b>(서버 기준 시간대, 보통 KST)가 보입니다.
                최소 간격은 5분입니다. 저장한 시각 이후의 다음 예정 시각부터 돌며, 저장 직후 갑자기 실행되지 않습니다.
                비활성 항목·수동 입력 항목은 주기가 있어도 자동 실행되지 않습니다.</p>
            </Section>
            <Section title="보관 기간">
              <p className="flex items-start gap-2">
                <Settings className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
                <span>툴바 톱니바퀴 — 셀 값 이력과 실행 기록의 보관 일수(1~3650일, 기본 90일). 지난 기록은 매일 03:00 에 정리됩니다.</span>
              </p>
            </Section>
          </div>
        )}

        {tab === 'sources' && (
          <div className="space-y-6">
            <Section title="등록된 점검 (점검 정의를 실행)">
              <p>PEP 내장 점검기(인증서 만료, etcd 단편화, PVC, CoreDNS, OOM, 노드 Pressure 등)와 커스텀 HTTP/kubectl/PromQL 입니다.</p>
              <ul className="list-disc pl-5 space-y-1">
                <li>임계값·파라미터는 <b>점검 정의</b>에 저장됩니다. 항목 수정·셀 「실행 계획 → 설정 편집」·운영 점검 화면에서 고칩니다.</li>
                <li>셀에서 고치면 <b>그 클러스터 전용 사본</b>이 만들어져 다른 클러스터에는 영향이 없습니다.</li>
                <li>여러 항목·전 클러스터가 함께 쓰는 <b>공유 설정</b>을 그대로 고치는 것은 admin 만 할 수 있습니다 —
                  operator 는 「이 항목만 따로 설정」 으로 분리해 저장합니다.</li>
                <li>그 클러스터에 실행할 정의가 없으면 셀은 <b>건너뜀</b>으로 기록됩니다.</li>
              </ul>
            </Section>
            <Section title="애드온 헬스 체크">
              <p>클러스터에 등록한 애드온(etcd, ArgoCD, Nexus, Jenkins, Keycloak, 시스템 파드 등)을 봅니다. 같은 타입의 애드온이 그 클러스터에
                없으면 건너뜁니다. 접속 주소·인증정보는 애드온 config 에서 옵니다.</p>
            </Section>
            <Section title="배치잡(SSH) · 플레이북(Ansible)">
              <p>/batch-jobs · /playbooks 에 등록한 잡을 <b>이름</b>으로 연결합니다 — 여러 클러스터에 같은 이름으로 등록해 두면 한 행이 열마다 실행됩니다.
                운영 스크립트라 등록 마법사의 테스트에서는 실행하지 않습니다(새로 작성한 플레이북은 dry-run 으로 테스트 가능).
                자동 실행은 잡에 저장된 스케줄용 자격증명을 씁니다. 플레이북의 <b>실행 제한 시간</b>(기본 30초, 최대 1800초)은 /playbooks 화면에서 정합니다.</p>
              <p>이 행들과 수동 입력 행은 항목 설정의 <b>「클러스터 상태에 반영」</b> 을 켜면 결과가 클러스터 종합 상태(사이드바 색)에도 들어갑니다 — 기본은 꺼짐입니다.</p>
            </Section>
            <Section title="수동 입력">
              <p>NAS 콘솔·네트워크 스위치·외주 점검처럼 PEP 가 직접 확인할 수 없는 대상입니다. 셀을 누르면 첫 탭이 <b>값 입력</b>이고,
                기록한 값은 자동 점검과 똑같이 추이·이력에 쌓이며 누가 넣었는지가 실행 기록에 남습니다. 실행 버튼과 주기는 없습니다.</p>
            </Section>
            <Section title="핵심 항목 (잠금)">
              <p>「K8S API-SERVER 응답시간」 행은 핵심 점검(API 서버·컴포넌트·노드·시스템 파드)을 한 번에 실행한 결과 중 응답시간을 보여줍니다.
                클러스터 상태(사이드바 색)를 결정하므로 셀 주기 대신 <b>클러스터 열 머리글의 주기</b>로 돌고, 삭제할 수 없습니다.</p>
            </Section>
          </div>
        )}
      </div>
    </SidePane>
  );
}
