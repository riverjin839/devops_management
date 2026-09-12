import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Pencil, GitBranch, Rocket, RefreshCw, Upload, Link2Off, Loader2, Trash2, Settings2, Ticket } from 'lucide-react';
import type { WorkItem } from '@/types';

export interface WorkItemActionsMenuProps {
  item: WorkItem;
  onEdit: (item: WorkItem) => void;
  onDelete: (item: WorkItem) => void;
  onAddSubItem: (parent: WorkItem) => void;
  /** Jira 연결 업무 — 행 단위 재가져오기 / Jira 로 보내기 (연결된 행에서만 노출). */
  onJiraRefresh?: (item: WorkItem) => void;
  onJiraPush?: (item: WorkItem) => void;
  /** 이 행에서 Jira 동기화가 진행 중인지 (버튼 스피너/중복 클릭 방지). */
  jiraBusy?: boolean;
  /** 아직 Jira 와 연결되지 않은 업무 — Jira·Confluence 자동 생성 진입. */
  onJiraProvision?: (item: WorkItem) => void;
  /** 연결 관리(해제/다른 이슈로 변경/업무 삭제) 다이얼로그 진입. */
  onJiraLink?: (item: WorkItem) => void;
  /** Jira 연동 업무 → 사내 ServiceNow ITSM 수동 등록 다이얼로그 진입. */
  onServiceNowRegister?: (item: WorkItem) => void;
  /** Confluence 연결 업무 — 현재 내용을 연결된 문서에 반영(재게시). Jira "보내기"와 동일 역할. */
  onConfluenceSync?: (item: WorkItem) => void;
  /** 이 행에서 Confluence 동기화가 진행 중인지 (버튼 스피너/중복 클릭 방지). */
  confluenceBusy?: boolean;
}

/**
 * "변경" 작업 목록 — 대표 아이콘(Settings2) 하나에 hover(또는 클릭)하면 전체 수정·Jira/
 * Confluence 생성·재가져오기·보내기·연결 관리·동기화·하위 업무 추가·삭제가 아이콘·색상·
 * 라벨을 갖춘 드롭다운으로 펼쳐진다. WorkItemTableRow(목록 뷰)와 WorkItemEpicView(에픽뷰)가
 * 동일하게 재사용 — 두 곳에서 로직이 갈라지면 한쪽만 고치고 잊어버리기 쉽다.
 *
 * 표가 가로 스크롤 + 모서리 라운딩용 `overflow-hidden` 컨테이너 안에 있어 드롭다운을 inline
 * `absolute` 로 열면 잘리므로, `SearchableSelect` 의 `menuPortal` 과 동일하게 `document.body`
 * 로 portal + `getBoundingClientRect()` 기반 `position: fixed` 앵커링을 쓴다.
 */
export function WorkItemActionsMenu({
  item, onEdit, onDelete, onAddSubItem, onJiraRefresh, onJiraPush, onJiraProvision, onJiraLink,
  onServiceNowRegister, jiraBusy = false, onConfluenceSync, confluenceBusy = false,
}: WorkItemActionsMenuProps) {
  const [open, setOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const closeTimer = useRef<number | null>(null);

  const openMenu = () => {
    if (closeTimer.current !== null) { window.clearTimeout(closeTimer.current); closeTimer.current = null; }
    setOpen(true);
  };
  const scheduleClose = () => {
    closeTimer.current = window.setTimeout(() => setOpen(false), 150);
  };

  useEffect(() => {
    if (!open) { setMenuPos(null); return; }
    const update = () => {
      const el = triggerRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
    };
    update();
    window.addEventListener('scroll', update, true);
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update, true);
      window.removeEventListener('resize', update);
    };
  }, [open]);

  // 바깥 클릭 시 닫기 — 예전엔 `fixed inset-0` 전체화면 오버레이로 처리했는데, 그 오버레이가
  // (portal 이라 트리거보다 나중에 마운트돼) 트리거 버튼 바로 위에 얹히면서 hover 이벤트를
  // 가로채 mouseleave→닫힘→다시 마우스가 트리거에 닿아 mouseenter→열림 을 반복해 박스가
  // 깜빡이는 버그가 있었다(ColumnSettingsMenu 와 동일하게 mousedown 리스너로 교체해 해결).
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target)) return;
      if (menuRef.current?.contains(target)) return;
      setOpen(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
  }, [open]);

  const isPartial = item.provisionStatus === 'partial';
  const menuItem = (className: string) =>
    `w-full flex items-center gap-2 px-2.5 py-1.5 rounded-md text-sm text-left hover:bg-secondary transition-colors disabled:opacity-50 disabled:cursor-not-allowed ${className}`;

  return (
    <div className="relative flex justify-center">
      <button
        ref={triggerRef}
        type="button"
        onMouseEnter={openMenu}
        onMouseLeave={scheduleClose}
        // 클릭은 항상 "열기" — hover 가 먼저 열어둔 상태에서 클릭이 토글로 동작하면
        // mouseenter 가 이미 켠 것을 곧바로 꺼버려 마우스 사용자에게 무반응처럼
        // 보였다(닫기는 바깥 클릭/마우스아웃 지연으로 충분히 처리됨).
        onClick={(e) => { e.stopPropagation(); openMenu(); }}
        className={`p-1.5 rounded-md transition-colors inline-flex items-center gap-1 ${
          isPartial ? 'text-status-warning hover:bg-status-warning/10' : 'text-primary hover:bg-primary/10'
        }`}
        title="변경 작업 목록"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label="변경 작업 목록 열기"
      >
        <Settings2 className="w-4 h-4" />
        {isPartial && <span className="w-1.5 h-1.5 rounded-full bg-status-warning flex-shrink-0" aria-hidden="true" />}
      </button>
      {open && menuPos && createPortal(
          <div
            ref={menuRef}
            onMouseEnter={openMenu}
            onMouseLeave={scheduleClose}
            style={{ position: 'fixed', top: menuPos.top, right: menuPos.right }}
            className="z-40 w-60 bg-card border border-border rounded-lg mac-shadow p-1"
          >
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onEdit(item); }}
              className={menuItem('text-foreground')}
              title="전체 수정 (리치 텍스트 / 이미지 포함)"
            >
              <Pencil className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />
              전체 수정
            </button>
            {(!item.jiraIssueKey || isPartial) && onJiraProvision && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onJiraProvision(item); }}
                className={menuItem(isPartial ? 'text-status-warning' : 'text-foreground')}
                title={isPartial
                  ? `일부만 생성됨 — ${!item.jiraIssueKey ? item.provisionJiraError || 'Jira 생성 실패' : item.provisionConfluenceError || 'Confluence 생성 실패'} (클릭해서 재시도)`
                  : 'Jira 이슈 · Confluence 문서 자동 생성'}
              >
                <Rocket className={`w-3.5 h-3.5 flex-shrink-0 ${isPartial ? 'text-status-warning' : 'text-primary'}`} />
                {isPartial ? '일부만 생성됨 — 재시도' : 'Jira · Confluence 자동 생성'}
              </button>
            )}
            {item.jiraIssueKey && onJiraRefresh && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onJiraRefresh(item); }}
                disabled={jiraBusy}
                className={menuItem('text-foreground')}
                title={`Jira(${item.jiraIssueKey})에서 다시 가져오기`}
              >
                {jiraBusy
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin text-brand-jira flex-shrink-0" />
                  : <RefreshCw className="w-3.5 h-3.5 text-brand-jira flex-shrink-0" />}
                Jira 다시 가져오기
              </button>
            )}
            {item.jiraIssueKey && onJiraPush && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onJiraPush(item); }}
                disabled={jiraBusy}
                className={menuItem('text-foreground')}
                title={`수정한 내용을 Jira(${item.jiraIssueKey})로 보내기`}
              >
                <Upload className="w-3.5 h-3.5 text-brand-jira flex-shrink-0" />
                Jira 로 보내기
              </button>
            )}
            {item.jiraIssueKey && onJiraLink && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onJiraLink(item); }}
                className={menuItem('text-foreground')}
                title={`Jira 연결 관리 (${item.jiraIssueKey} 해제 · 다른 이슈로 변경)`}
              >
                <Link2Off className="w-3.5 h-3.5 text-brand-jira flex-shrink-0" />
                Jira 연결 관리
              </button>
            )}
            {item.jiraIssueKey && onServiceNowRegister && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onServiceNowRegister(item); }}
                className={menuItem('text-foreground')}
                title={item.servicenowNumber
                  ? `ServiceNow(${item.servicenowNumber}) 등록됨 — 다시 등록`
                  : 'Jira 연동 정보로 사내 ServiceNow ITSM 티켓 생성'}
              >
                <Ticket className="w-3.5 h-3.5 text-brand-servicenow flex-shrink-0" />
                {item.servicenowNumber ? 'ServiceNow 다시 등록' : 'ServiceNow ITSM 등록'}
              </button>
            )}
            {item.confluenceUrl && onConfluenceSync && (
              <button
                onClick={(e) => { e.stopPropagation(); setOpen(false); onConfluenceSync(item); }}
                disabled={confluenceBusy}
                className={menuItem('text-foreground')}
                title="수정한 내용을 연결된 Confluence 문서에 반영"
              >
                {confluenceBusy
                  ? <Loader2 className="w-3.5 h-3.5 animate-spin text-status-info flex-shrink-0" />
                  : <Upload className="w-3.5 h-3.5 text-status-info flex-shrink-0" />}
                Confluence 문서 동기화
              </button>
            )}
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onAddSubItem(item); }}
              className={menuItem('text-foreground')}
              title="하위 업무 추가"
            >
              <GitBranch className="w-3.5 h-3.5 text-primary flex-shrink-0" />
              하위 업무 추가
            </button>
            <div className="my-1 border-t border-border" />
            <button
              onClick={(e) => { e.stopPropagation(); setOpen(false); onDelete(item); }}
              className={menuItem('text-status-critical hover:bg-status-critical/10')}
              title="삭제"
            >
              <Trash2 className="w-3.5 h-3.5 flex-shrink-0" />
              삭제
            </button>
          </div>,
        document.body,
      )}
    </div>
  );
}
