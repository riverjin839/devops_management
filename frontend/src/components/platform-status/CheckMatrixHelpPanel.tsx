import { SidePane } from '@/components/common';
import { StatusDot } from '@/components/common';
import {
  Plus, Pencil, Trash2, Lock, Clock, Settings, ChevronUp, ChevronDown,
} from 'lucide-react';

interface Props {
  open: boolean;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">{title}</h3>
      <div className="text-sm text-foreground/90 space-y-2">{children}</div>
    </section>
  );
}

export function CheckMatrixHelpPanel({ open, onClose }: Props) {
  return (
    <SidePane open={open} onClose={onClose} title="점검 매트릭스 사용법" width="440px">
      <div className="space-y-6 pb-4">
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
          <p>셀을 클릭하면 우측에 상세 패널이 열립니다.</p>
          <ul className="list-disc pl-5 space-y-1">
            <li>기간별(7/30/90일) 추이 차트</li>
            <li>상태가 바뀐 시점의 변경 이력</li>
            <li><b>수동 입력</b> 타입 항목이면 값을 직접 입력하는 폼</li>
            <li>핵심(잠금) 항목이 아니면, 이 클러스터에서 해당 항목을 실행할 cron 주기를 여기서 설정</li>
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

        <Section title="이력 보관 설정">
          <p className="flex items-start gap-2">
            <Settings className="w-4 h-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span>카드 우측 상단 톱니바퀴에서 셀 이력(추이/변경 이력)의 보관 일수를 설정합니다. 보관 기간이
              지난 이력은 매일 자동으로 정리됩니다 — DB 용량을 고려해 설정하세요.</span>
          </p>
        </Section>
      </div>
    </SidePane>
  );
}
