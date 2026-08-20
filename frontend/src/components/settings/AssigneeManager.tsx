import { useId, useMemo, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import {
  UserCheck, UserPlus, Check, X as XIcon, Trash2, Download, ClipboardCopy,
  KeyRound, Loader2, ShieldPlus,
} from 'lucide-react';
import { useAssignees, useUpdateAssignees } from '@/hooks/useAssignees';
import { useToast, ResizeGrip, DoubleScrollX, ConfirmDialog, useModalA11y } from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { authApi, type UserRoleApi } from '@/services/api';
import { useAuthStore } from '@/stores/authStore';
import { formatApiError } from '@/lib/utils';
import { Assignee } from '@/types';

const ASSIGNEE_COLUMNS: { key: keyof Assignee; label: string }[] = [
  { key: 'employeeId', label: '사번' },
  { key: 'name', label: '이름' },
  { key: 'email', label: '이메일' },
  { key: 'ip', label: 'IP 주소' },
  { key: 'seatLocation', label: '좌석 위치' },
  { key: 'primaryRole', label: '정 담당역할' },
  { key: 'secondaryRole', label: '부담당 역할' },
];

const ACCOUNT_ROLES: { value: UserRoleApi; label: string; desc: string }[] = [
  { value: 'viewer', label: 'Viewer', desc: '조회 전용' },
  { value: 'operator', label: 'Operator', desc: '쓰기/실행' },
  { value: 'admin', label: 'Admin', desc: '전체 권한 + 계정 관리' },
];

// CSV 필드 이스케이프 — 콤마/따옴표/개행이 있으면 큰따옴표로 감싸고 내부 따옴표는 두 배로.
function csvEscape(value: string): string {
  if (/[",\n]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function assigneesToCsv(assignees: Assignee[]): string {
  const header = ASSIGNEE_COLUMNS.map((c) => csvEscape(c.label)).join(',');
  const rows = assignees.map((a) => ASSIGNEE_COLUMNS.map((c) => csvEscape((a[c.key] as string) || '')).join(','));
  return [header, ...rows].join('\n');
}

function assigneesToMarkdown(assignees: Assignee[]): string {
  const header = `| ${ASSIGNEE_COLUMNS.map((c) => c.label).join(' | ')} |`;
  const divider = `| ${ASSIGNEE_COLUMNS.map(() => '---').join(' | ')} |`;
  const rows = assignees.map((a) => `| ${ASSIGNEE_COLUMNS.map((c) => (a[c.key] as string) || '').join(' | ')} |`);
  return [header, divider, ...rows].join('\n');
}

// 관리자/서비스 계정 추가 — 담당자 명부와 무관한(사번이 없는) 로그인 전용 계정을 만들 때만 쓴다.
// 대부분의 담당자는 아래 표에서 사번을 입력하면 로그인 계정이 자동으로 딸려온다.
function CreateAccountModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRoleApi>('viewer');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fid = useId();
  const f = (k: string) => `${fid}-${k}`;
  const dialogRef = useModalA11y(open, onClose);

  if (!open) return null;

  const submit = async () => {
    if (submitting) return;
    setError(null);
    if (!username.trim() || password.length < 4) {
      setError('사용자명과 4자 이상 비밀번호를 입력하세요.');
      return;
    }
    setSubmitting(true);
    try {
      await authApi.createUser({
        username: username.trim(),
        password,
        role,
        displayName: displayName.trim() || undefined,
      });
      toast.success(`계정 ${username} 이(가) 추가되었습니다.`);
      qc.invalidateQueries({ queryKey: ['assignees'] });
      setUsername(''); setPassword(''); setDisplayName(''); setRole('viewer');
      onClose();
    } catch (err) {
      setError(formatApiError(err) ?? '계정 생성에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={f('title')} className="w-full max-w-md bg-card border border-border rounded-2xl p-5 mac-shadow">
        <h3 id={f('title')} className="text-base font-bold mb-1">관리자 / 서비스 계정 추가</h3>
        <p className="text-sm text-muted-foreground mb-4">담당자 명부에 없는(사번 없는) 로그인 전용 계정을 만듭니다.</p>
        <div className="space-y-3">
          <div>
            <label htmlFor={f('u')} className="block text-sm mb-1">사용자명</label>
            <input id={f('u')} autoComplete="off" value={username} onChange={(e) => setUsername(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>
          <div>
            <label htmlFor={f('p')} className="block text-sm mb-1">초기 비밀번호 (4자 이상)</label>
            <input id={f('p')} type="password" autoComplete="new-password" value={password} onChange={(e) => setPassword(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>
          <div>
            <label htmlFor={f('d')} className="block text-sm mb-1">표시 이름 (선택)</label>
            <input id={f('d')} autoComplete="off" value={displayName} onChange={(e) => setDisplayName(e.target.value)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
          </div>
          <div>
            <label htmlFor={f('r')} className="block text-sm mb-1">역할</label>
            <select id={f('r')} value={role} onChange={(e) => setRole(e.target.value as UserRoleApi)}
              className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm">
              {ACCOUNT_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label} — {r.desc}</option>)}
            </select>
          </div>
          {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        </div>
        <div className="flex justify-end gap-2 mt-5">
          <button type="button" onClick={onClose} disabled={submitting}
            className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted">취소</button>
          <button type="button" onClick={submit} disabled={submitting}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1">
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
            추가
          </button>
        </div>
      </div>
    </div>
  );
}

function ResetPasswordModal({ target, onClose }: { target: Assignee | null; onClose: () => void }) {
  const qc = useQueryClient();
  const toast = useToast();
  const [newPassword, setNewPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useModalA11y(!!target, onClose);
  const titleId = useId();

  if (!target) return null;

  const submit = async () => {
    if (submitting || !target.id) return;
    if (newPassword.length < 4) { setError('4자 이상 입력하세요.'); return; }
    setSubmitting(true);
    try {
      await authApi.resetPassword(target.id, newPassword);
      toast.success(`${target.username} 비밀번호가 재설정되었습니다.`);
      qc.invalidateQueries({ queryKey: ['assignees'] });
      setNewPassword('');
      onClose();
    } catch (err) {
      setError(formatApiError(err) ?? '비밀번호 재설정에 실패했습니다.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby={titleId} className="w-full max-w-sm bg-card border border-border rounded-2xl p-5 mac-shadow">
        <h3 id={titleId} className="text-base font-bold mb-2">{target.username} 비밀번호 재설정</h3>
        <p className="text-sm text-muted-foreground mb-3">새 비밀번호를 입력하세요. 변경 즉시 적용됩니다.</p>
        <input type="password" autoComplete="new-password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)}
          minLength={4} className="w-full px-3 py-2 bg-background border border-border rounded-xl text-sm" />
        {error && <p role="alert" className="text-sm text-destructive mt-2">{error}</p>}
        <div className="flex justify-end gap-2 mt-4">
          <button type="button" onClick={onClose} disabled={submitting}
            className="px-3 py-1.5 text-sm bg-secondary border border-border rounded-xl hover:bg-muted">취소</button>
          <button type="button" onClick={submit} disabled={submitting || newPassword.length < 4}
            className="px-3 py-1.5 text-sm bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50 flex items-center gap-1">
            {submitting ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <KeyRound className="w-3.5 h-3.5" />}
            재설정
          </button>
        </div>
      </div>
    </div>
  );
}

// 담당자 명부 겸 로그인 계정 관리 — Settings ▸ 시스템 담당자 탭 (admin 전용).
// 예전에는 "담당자 명부"/"로그인 계정" 두 서브탭 + 두 저장소(app_settings JSON / users 테이블)로
// 나뉘어 있었다 — 명부를 고쳐도 이미 만든 로그인 계정에 반영이 안 되는 문제가 있었다. 지금은
// users 테이블 자체가 명부라 이 표 하나가 두 화면 몫을 다 한다.
export function AssigneeManager() {
  const { data: assignees = [] } = useAssignees();
  const updateAssignees = useUpdateAssignees();
  const toast = useToast();
  const qc = useQueryClient();
  const me = useAuthStore((s) => s.user);

  const showAssigneeError = (err: unknown) => {
    const resp = (err as { response?: { data?: { detail?: unknown } } })?.response;
    const detail = resp?.data?.detail;
    const msg =
      typeof detail === 'string'
        ? detail
        : (detail as { message?: string })?.message ?? '담당자 저장 중 오류가 발생했습니다.';
    toast.error('담당자 저장 실패', msg);
  };

  const [editingIdx, setEditingIdx] = useState<number | null>(null);
  const [editForm, setEditForm] = useState<Assignee>({ name: '' });
  const [showAddRow, setShowAddRow] = useState(false);
  const [addForm, setAddForm] = useState<Assignee>({ name: '' });
  const [createAccountOpen, setCreateAccountOpen] = useState(false);
  const [resetTarget, setResetTarget] = useState<Assignee | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Assignee | null>(null);
  const [roleUpdatingId, setRoleUpdatingId] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);

  const assigneeColW = useColumnWidths('settings-assignee-table', {
    defaults: { empId: 100, name: 140, email: 220, ip: 150, seatLocation: 130, primaryRole: 180, secondaryRole: 180, account: 150, actions: 130 },
    min: 60, max: 600,
  });

  const handleSaveAssignee = (idx: number) => {
    if (!editForm.name.trim()) return;
    const updated = assignees.map((a, i) => (i === idx ? { ...a, ...editForm, name: editForm.name.trim() } : a));
    updateAssignees.mutate(updated, {
      onSuccess: () => { setEditingIdx(null); toast.success('담당자 저장됨'); },
      onError: showAssigneeError,
    });
  };

  const handleAddAssignee = () => {
    if (!addForm.name.trim()) return;
    if (assignees.some(a => (a.name || '').trim().toLowerCase() === addForm.name.trim().toLowerCase())) {
      toast.error('중복된 담당자', `"${addForm.name.trim()}" 이름이 이미 있습니다. 담당자 이름과 사번은 고유해야 합니다.`);
      return;
    }
    updateAssignees.mutate([...assignees, { ...addForm, name: addForm.name.trim() }], {
      onSuccess: () => { setAddForm({ name: '' }); setShowAddRow(false); toast.success('담당자 추가됨'); },
      onError: showAssigneeError,
    });
  };

  const handleDeleteConfirmed = async () => {
    if (!deleteTarget?.id || deleting) return;
    setDeleting(true);
    try {
      await authApi.deleteUser(deleteTarget.id);
      toast.success(`${deleteTarget.name} 삭제됨`);
      qc.invalidateQueries({ queryKey: ['assignees'] });
      if (editingIdx !== null && assignees[editingIdx]?.id === deleteTarget.id) setEditingIdx(null);
    } catch (err) {
      toast.error('삭제 실패', formatApiError(err) ?? undefined);
    } finally {
      setDeleting(false);
      setDeleteTarget(null);
    }
  };

  const handleRoleChange = async (a: Assignee, role: UserRoleApi) => {
    if (!a.id) return;
    setRoleUpdatingId(a.id);
    try {
      await authApi.updateUserRole(a.id, role);
      toast.success('역할이 변경되었습니다.');
      qc.invalidateQueries({ queryKey: ['assignees'] });
    } catch (err) {
      toast.error('역할 변경 실패', formatApiError(err) ?? undefined);
    } finally {
      setRoleUpdatingId(null);
    }
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditForm({ ...assignees[idx] });
    setShowAddRow(false);
  };

  const handleExportCsv = () => {
    if (assignees.length === 0) return;
    const blob = new Blob(['﻿' + assigneesToCsv(assignees)], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `assignees-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleCopyMarkdown = async () => {
    if (assignees.length === 0) return;
    try {
      await navigator.clipboard.writeText(assigneesToMarkdown(assignees));
      toast.success('마크다운 표 복사됨', '클립보드에 복사했습니다.');
    } catch {
      toast.error('복사 실패', '클립보드 접근 권한을 확인하세요.');
    }
  };

  const sortedAssignees = useMemo(() => assignees, [assignees]);

  return (
    <div className="bg-card border border-border rounded-xl">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">담당자 관리</h2>
          <span className="text-sm text-muted-foreground ml-1">작업/이슈 등록 시 자동완성 · 행 클릭으로 바로 수정 · 로그인 계정 겸용</span>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={handleCopyMarkdown}
            disabled={assignees.length === 0}
            title="마크다운 표로 클립보드에 복사"
            className="px-3 py-2 text-sm font-medium bg-secondary hover:bg-muted border border-border rounded-lg transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <ClipboardCopy className="w-4 h-4" />
            .md 복사
          </button>
          <button
            onClick={handleExportCsv}
            disabled={assignees.length === 0}
            title="CSV 파일로 내보내기"
            className="px-3 py-2 text-sm font-medium bg-secondary hover:bg-muted border border-border rounded-lg transition-colors flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
          >
            <Download className="w-4 h-4" />
            CSV 내보내기
          </button>
          <button
            onClick={() => setCreateAccountOpen(true)}
            title="담당자 명부와 무관한 로그인 전용 계정 추가"
            className="px-3 py-2 text-sm font-medium bg-secondary hover:bg-muted border border-border rounded-lg transition-colors flex items-center gap-2"
          >
            <ShieldPlus className="w-4 h-4" />
            관리자 계정 추가
          </button>
          <button
            onClick={() => { setShowAddRow(true); setEditingIdx(null); setAddForm({ name: '' }); }}
            className="px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors flex items-center gap-2"
          >
            <UserPlus className="w-4 h-4" />
            담당자 추가
          </button>
        </div>
      </div>

      <div className="px-6 py-3 border-b border-border bg-primary/5 text-sm text-muted-foreground leading-relaxed">
        사번을 입력해 담당자를 등록하면 <b className="text-foreground font-medium">자동으로 로그인 계정</b>이 생성됩니다 —
        아이디와 초기 비밀번호는 모두 <b className="text-foreground font-medium">사번</b>, 권한은 <b className="text-foreground font-medium">OPERATOR</b>입니다.
        사번을 지우면 로그인 계정도 함께 해제됩니다. 로그인 후 사용자 메뉴에서 비밀번호를 변경하세요.
      </div>

      <DoubleScrollX>
        <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
          <colgroup>
            {(['empId', 'name', 'email', 'ip', 'seatLocation', 'primaryRole', 'secondaryRole', 'account', 'actions'] as const).map((k) => (
              <col key={k} style={{ width: `${assigneeColW.getWidth(k)}px` }} />
            ))}
          </colgroup>
          <thead>
            <tr className="bg-secondary/40 border-b border-border text-sm text-muted-foreground">
              <th className="relative text-left px-4 py-3 font-medium">사번
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('empId', e)} onDoubleClick={() => assigneeColW.autoFit('empId')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">이름 *
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('name', e)} onDoubleClick={() => assigneeColW.autoFit('name')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">이메일
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('email', e)} onDoubleClick={() => assigneeColW.autoFit('email')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">IP 주소
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('ip', e)} onDoubleClick={() => assigneeColW.autoFit('ip')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">좌석 위치
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('seatLocation', e)} onDoubleClick={() => assigneeColW.autoFit('seatLocation')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">정 담당역할
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('primaryRole', e)} onDoubleClick={() => assigneeColW.autoFit('primaryRole')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">부담당 역할
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('secondaryRole', e)} onDoubleClick={() => assigneeColW.autoFit('secondaryRole')} />
              </th>
              <th className="relative text-left px-4 py-3 font-medium">로그인 계정
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('account', e)} onDoubleClick={() => assigneeColW.autoFit('account')} />
              </th>
              <th className="relative px-3 py-3">
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('actions', e)} onDoubleClick={() => assigneeColW.autoFit('actions')} />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {sortedAssignees.map((a, idx) => {
              const isEditing = editingIdx === idx;
              const isSelf = !!a.id && a.id === me?.id;
              const cellInput = (field: keyof Assignee, placeholder: string, required?: boolean) => (
                <input
                  type="text"
                  value={(editForm[field] as string) ?? ''}
                  onChange={(e) => setEditForm((f) => ({ ...f, [field]: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') handleSaveAssignee(idx); if (e.key === 'Escape') setEditingIdx(null); }}
                  placeholder={placeholder}
                  required={required}
                  className="w-full px-2 py-1 bg-background border border-primary/40 rounded text-sm focus:outline-none focus:ring-1 focus:ring-primary"
                  autoFocus={field === 'name'}
                />
              );
              return (
                <tr
                  key={a.id ?? idx}
                  onClick={() => !isEditing && startEdit(idx)}
                  className={`transition-colors ${isEditing ? 'bg-primary/5' : 'hover:bg-muted/30 cursor-pointer'}`}
                >
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('employeeId', 'EMP001') : (
                      <span className="text-muted-foreground font-mono text-sm">{a.employeeId || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('name', '이름', true) : (
                      <div className="flex items-center gap-2">
                        <span className="w-7 h-7 rounded-full bg-primary/20 text-primary flex items-center justify-center text-sm font-bold flex-shrink-0">
                          {(a.name || '?').charAt(0).toUpperCase()}
                        </span>
                        <span className="font-medium">{a.name || '(이름없음)'}</span>
                        {isSelf && <span className="text-sm text-muted-foreground">(나)</span>}
                      </div>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('email', 'user@company.com') : (
                      <span className="text-muted-foreground">{a.email || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('ip', '10.0.0.1') : (
                      <span className="font-mono text-sm text-muted-foreground">{a.ip || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('seatLocation', '3층 A-12') : (
                      <span className="text-muted-foreground">{a.seatLocation || '—'}</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('primaryRole', 'Backend Engineer') : (
                      a.primaryRole
                        ? <span className="text-sm px-2 py-0.5 rounded-full bg-blue-500/10 text-blue-400 border border-blue-500/20">{a.primaryRole}</span>
                        : <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5">
                    {isEditing ? cellInput('secondaryRole', 'DevOps') : (
                      a.secondaryRole
                        ? <span className="text-sm px-2 py-0.5 rounded-full bg-purple-500/10 text-purple-400 border border-purple-500/20">{a.secondaryRole}</span>
                        : <span className="text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5" onClick={(e) => e.stopPropagation()}>
                    {a.hasLogin ? (
                      <div className="flex items-center gap-1.5">
                        <span className="font-mono text-sm text-muted-foreground truncate" title={a.username}>{a.username}</span>
                        <select
                          value={a.accountRole ?? 'viewer'}
                          onChange={(e) => handleRoleChange(a, e.target.value as UserRoleApi)}
                          disabled={isSelf || roleUpdatingId === a.id}
                          className="px-1.5 py-0.5 bg-background border border-border rounded-md text-sm disabled:opacity-50"
                        >
                          {ACCOUNT_ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                        </select>
                      </div>
                    ) : (
                      <span className="text-sm text-muted-foreground">로그인 없음(사번 미등록)</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {isEditing ? (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleSaveAssignee(idx)} disabled={!editForm.name.trim()} title="저장"
                          className="p-1.5 rounded bg-primary/10 hover:bg-primary/20 text-primary transition-colors disabled:opacity-40">
                          <Check className="w-3.5 h-3.5" />
                        </button>
                        <button onClick={() => setEditingIdx(null)} title="취소"
                          className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
                          <XIcon className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center gap-1" onClick={(e) => e.stopPropagation()}>
                        {a.hasLogin && (
                          <button onClick={() => setResetTarget(a)} title="비밀번호 재설정"
                            className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
                            <KeyRound className="w-3.5 h-3.5" />
                          </button>
                        )}
                        <button onClick={() => setDeleteTarget(a)} disabled={isSelf || !a.id}
                          title={isSelf ? '자기 자신은 삭제할 수 없습니다' : '삭제'}
                          className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    )}
                  </td>
                </tr>
              );
            })}

            {/* Add new row */}
            {showAddRow && (
              <tr className="bg-emerald-500/5 border-t-2 border-emerald-500/30">
                {(['employeeId', 'name', 'email', 'ip', 'seatLocation', 'primaryRole', 'secondaryRole'] as (keyof Assignee)[]).map((field) => (
                  <td key={field} className="px-4 py-2.5">
                    <input
                      type="text"
                      value={(addForm[field] as string) ?? ''}
                      onChange={(e) => setAddForm((f) => ({ ...f, [field]: e.target.value }))}
                      onKeyDown={(e) => { if (e.key === 'Enter') handleAddAssignee(); if (e.key === 'Escape') setShowAddRow(false); }}
                      placeholder={
                        field === 'employeeId' ? 'EMP001'
                        : field === 'name' ? '이름 *'
                        : field === 'email' ? 'user@co.kr'
                        : field === 'ip' ? '10.0.0.1'
                        : field === 'seatLocation' ? '3층 A-12'
                        : field === 'primaryRole' ? '정 담당역할'
                        : '부담당 역할'
                      }
                      aria-label={
                        field === 'employeeId' ? '사번 입력'
                        : field === 'name' ? '이름 입력'
                        : field === 'email' ? '이메일 입력'
                        : field === 'ip' ? 'IP 입력'
                        : field === 'seatLocation' ? '좌석 위치 입력'
                        : field === 'primaryRole' ? '정 담당역할 입력'
                        : '부담당 역할 입력'
                      }
                      autoFocus={field === 'name'}
                      className="w-full px-2 py-1 bg-background border border-emerald-500/40 rounded text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </td>
                ))}
                <td className="px-4 py-2.5 text-sm text-muted-foreground">사번 입력 시 자동 생성</td>
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <button onClick={handleAddAssignee} disabled={!addForm.name.trim()} title="추가" aria-label="추가"
                      className="p-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 transition-colors disabled:opacity-40">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setShowAddRow(false)} title="취소" aria-label="취소"
                      className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {assignees.length === 0 && !showAddRow && (
              <tr>
                <td colSpan={9} className="text-center py-10 text-muted-foreground text-sm">
                  등록된 담당자가 없습니다. "담당자 추가" 버튼을 클릭하세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </DoubleScrollX>

      <CreateAccountModal open={createAccountOpen} onClose={() => setCreateAccountOpen(false)} />
      <ResetPasswordModal target={resetTarget} onClose={() => setResetTarget(null)} />
      <ConfirmDialog
        open={!!deleteTarget}
        title="담당자 삭제"
        description={deleteTarget ? `"${deleteTarget.name}"${deleteTarget.hasLogin ? ' (로그인 계정 포함)' : ''}을(를) 정말 삭제하시겠습니까? 이 작업은 되돌릴 수 없습니다.` : ''}
        confirmLabel="삭제"
        danger
        onConfirm={handleDeleteConfirmed}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  );
}
