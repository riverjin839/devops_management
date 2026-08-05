import { useEffect, useId, useState } from 'react';
import { Loader2, Save, UserCheck } from 'lucide-react';
import { useAssignees, useUpdateMyAssignee } from '@/hooks/useAssignees';
import { useToastSafe } from '@/components/common';
import { formatApiError } from '@/lib/utils';
import { useAuthStore } from '@/stores/authStore';
import { Assignee } from '@/types';

// 사용자 메뉴 SidePane 상단에 표시되는 "본인 담당자 정보" 폼.
// 담당자 계정은 username = employeeId 로 provisioning 되므로, 이 매칭으로 본인 레코드만 찾아 편집한다.
// 저장은 본인 행만 부분 갱신하는 PUT /ui-settings/assignees/me 로 나간다 — 전체 목록을 덮어쓰는
// admin 전용 PUT /ui-settings/assignees 를 쓰면 operator 가 본인 IP 를 바꿀 때 403 이 난다.
// 전체 담당자 목록 관리는 Settings ▸ 담당자 탭(admin 전용)에서만 가능.
export function SelfAssigneePanel({ onSaved }: { onSaved?: () => void }) {
  const currentUser = useAuthStore((s) => s.user);
  const { data: assignees = [], isLoading } = useAssignees();
  const updateMyAssignee = useUpdateMyAssignee();
  const toast = useToastSafe();

  const myIdx = assignees.findIndex(
    (a) => (a.employeeId || '').trim() && a.employeeId === currentUser?.username,
  );
  const mine = myIdx >= 0 ? assignees[myIdx] : null;

  const [form, setForm] = useState<Assignee | null>(null);
  // 필드 값으로만 재동기화 — assignees 배열은 매 fetch 마다 새 참조라 mine 객체째로 넣으면 매번 폼이 리셋된다.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => { setForm(mine ? { ...mine } : null); }, [mine?.email, mine?.ip, mine?.seatLocation, mine?.primaryRole, mine?.secondaryRole]);

  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;

  const dirty = !!form && !!mine && (
    form.email !== mine.email || form.ip !== mine.ip || form.seatLocation !== mine.seatLocation ||
    form.primaryRole !== mine.primaryRole || form.secondaryRole !== mine.secondaryRole
  );

  const handleSave = () => {
    if (!form || myIdx < 0) return;
    // 이름/사번은 보내지 않는다 — 서버에서도 본인이 바꿀 수 없는 필드로 막혀 있다.
    updateMyAssignee.mutate(
      {
        email: form.email,
        ip: form.ip,
        seatLocation: form.seatLocation,
        primaryRole: form.primaryRole,
        secondaryRole: form.secondaryRole,
      },
      {
        onSuccess: () => { toast.success('내 정보 저장됨'); onSaved?.(); },
        onError: (e) => toast.error('저장 실패', formatApiError(e)),
      },
    );
  };

  if (isLoading) {
    return (
      <div className="px-5 py-4 text-sm text-muted-foreground flex items-center gap-2">
        <Loader2 className="w-4 h-4 animate-spin" /> 불러오는 중…
      </div>
    );
  }

  if (!mine || !form) {
    return (
      <div className="px-5 py-4 text-sm text-muted-foreground leading-relaxed">
        등록된 담당자 정보가 없습니다. 관리자에게 사번 등록을 요청하세요.
      </div>
    );
  }

  const field = (key: keyof Assignee, label: string, placeholder: string) => (
    <div>
      <label htmlFor={f(key)} className="block text-xs font-medium text-muted-foreground mb-1">{label}</label>
      <input
        id={f(key)}
        type="text"
        value={(form[key] as string) ?? ''}
        onChange={(e) => setForm((cur) => (cur ? { ...cur, [key]: e.target.value } : cur))}
        placeholder={placeholder}
        className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-primary"
      />
    </div>
  );

  return (
    <div className="px-5 py-4 space-y-3">
      <div className="flex items-center gap-2 text-sm font-semibold">
        <UserCheck className="w-4 h-4 text-primary" />
        {mine.name}
        <span className="text-xs font-normal text-muted-foreground">{mine.employeeId}</span>
      </div>
      {field('email', '이메일', 'user@company.com')}
      {field('ip', 'IP 주소', '10.0.0.1')}
      {field('seatLocation', '좌석 위치', '3층 A-12')}
      {field('primaryRole', '정 담당역할', 'Backend Engineer')}
      {field('secondaryRole', '부담당 역할', 'DevOps')}
      <button
        type="button"
        onClick={handleSave}
        disabled={!dirty || updateMyAssignee.isPending}
        className="w-full flex items-center justify-center gap-2 px-3 py-2 text-sm font-medium bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        {updateMyAssignee.isPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
        저장
      </button>
    </div>
  );
}
