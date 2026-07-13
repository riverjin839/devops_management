import { useState } from 'react';
import { UserCheck, UserPlus, Check, X as XIcon, Trash2, Download, ClipboardCopy } from 'lucide-react';
import { useAssignees, useUpdateAssignees } from '@/hooks/useAssignees';
import { useToast, ResizeGrip, DoubleScrollX } from '@/components/common';
import { useColumnWidths } from '@/hooks/useColumnWidths';
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

// 담당자 관리 — Settings ▸ 담당자 탭 (admin 전용).
export function AssigneeManager() {
  const { data: assignees = [] } = useAssignees();
  const updateAssignees = useUpdateAssignees();
  const toast = useToast();

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

  const assigneeColW = useColumnWidths('settings-assignee-table', {
    defaults: { empId: 100, name: 140, email: 220, ip: 150, seatLocation: 130, primaryRole: 200, secondaryRole: 200, actions: 90 },
    min: 60, max: 600,
  });

  const handleSaveAssignee = (idx: number) => {
    if (!editForm.name.trim()) return;
    const updated = assignees.map((a, i) => (i === idx ? { ...editForm, name: editForm.name.trim() } : a));
    updateAssignees.mutate(updated, {
      onSuccess: () => { setEditingIdx(null); toast.success('담당자 저장됨'); },
      onError: showAssigneeError,
    });
  };

  const handleAddAssignee = () => {
    if (!addForm.name.trim()) return;
    // 이름은 고유해야 함 (대소문자/공백 무시). 서버에서도 사번 포함 재검증.
    if (assignees.some(a => (a.name || '').trim().toLowerCase() === addForm.name.trim().toLowerCase())) {
      toast.error('중복된 담당자', `"${addForm.name.trim()}" 이름이 이미 있습니다. 담당자 이름과 사번은 고유해야 합니다.`);
      return;
    }
    updateAssignees.mutate([...assignees, { ...addForm, name: addForm.name.trim() }], {
      onSuccess: () => { setAddForm({ name: '' }); setShowAddRow(false); toast.success('담당자 추가됨'); },
      onError: showAssigneeError,
    });
  };

  const handleDeleteAssignee = (idx: number) => {
    updateAssignees.mutate(assignees.filter((_, i) => i !== idx), {
      onSuccess: () => { if (editingIdx === idx) setEditingIdx(null); },
      onError: showAssigneeError,
    });
  };

  const startEdit = (idx: number) => {
    setEditingIdx(idx);
    setEditForm({ ...assignees[idx] });
    setShowAddRow(false);
  };

  const handleExportCsv = () => {
    if (assignees.length === 0) return;
    // 엑셀 한글 깨짐 방지 — UTF-8 BOM 추가.
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

  return (
    <div className="bg-card border border-border rounded-xl">
      <div className="px-6 py-4 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <UserCheck className="w-4 h-4 text-primary" />
          <h2 className="font-semibold">담당자 관리</h2>
          <span className="text-sm text-muted-foreground ml-1">작업/이슈 등록 시 자동완성 · 행 클릭으로 바로 수정</span>
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
        로그인 후 사용자 메뉴에서 비밀번호를 변경하세요. (사번이 없는 담당자는 계정이 생성되지 않습니다.)
      </div>

      <DoubleScrollX>
        <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
          <colgroup>
            {(['empId', 'name', 'email', 'ip', 'seatLocation', 'primaryRole', 'secondaryRole', 'actions'] as const).map((k) => (
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
              <th className="relative px-3 py-3">
                <ResizeGrip onMouseDown={(e) => assigneeColW.beginResize('actions', e)} onDoubleClick={() => assigneeColW.autoFit('actions')} />
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {assignees.map((a, idx) => {
              const isEditing = editingIdx === idx;
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
                  key={idx}
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
                      <div className="flex items-center gap-1 opacity-0 group-hover:opacity-100" onClick={(e) => e.stopPropagation()}>
                        <button onClick={() => handleDeleteAssignee(idx)} title="삭제"
                          className="p-1.5 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400 transition-colors">
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
                      autoFocus={field === 'name'}
                      className="w-full px-2 py-1 bg-background border border-emerald-500/40 rounded text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500"
                    />
                  </td>
                ))}
                <td className="px-3 py-2.5">
                  <div className="flex items-center gap-1">
                    <button onClick={handleAddAssignee} disabled={!addForm.name.trim()} title="추가"
                      className="p-1.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 transition-colors disabled:opacity-40">
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button onClick={() => setShowAddRow(false)} title="취소"
                      className="p-1.5 rounded hover:bg-secondary text-muted-foreground transition-colors">
                      <XIcon className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </td>
              </tr>
            )}

            {assignees.length === 0 && !showAddRow && (
              <tr>
                <td colSpan={8} className="text-center py-10 text-muted-foreground text-sm">
                  등록된 담당자가 없습니다. "담당자 추가" 버튼을 클릭하세요.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </DoubleScrollX>
    </div>
  );
}
