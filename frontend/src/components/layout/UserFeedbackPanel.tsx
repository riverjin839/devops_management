/* eslint-disable react-refresh/only-export-components -- USER_FEEDBACK_TAB_TITLE 는 Sidebar 의
   SidePane title 계산에 필요해 컴포넌트와 함께 export 한다. */
import { MessageSquare, ScrollText, Bug } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VocBoardPanel } from './VocBoardPanel';
import { ReleaseNotesPanel } from './ReleaseNotesPanel';
import { BugFixLogPanel } from './BugFixLogPanel';

// 사이드바 "사용자 VOC 게시판" 진입점 하나로 VOC / 릴리즈 노트 / 버그 픽스 로그 SidePane 3개를
// 통합한다(예전엔 레일 아이콘 3개 → SidePane 3개였다). 세 패널은 성격이 비슷한 "공지·피드백"
// 계열이라 아이콘 3개를 레일에 나란히 두는 대신 탭으로 묶었다. 각 탭 본문 컴포넌트는 그대로
// 재사용하고, `open` 은 패널이 열려있고 해당 탭이 활성일 때만 true 로 넘겨 비활성 탭의
// 데이터 훅(useVocPosts/useReleaseNotes)이 불필요하게 미리 fetch 하지 않게 한다.
export type UserFeedbackTab = 'voc' | 'release-notes' | 'bug-fix-log';
type TabKey = UserFeedbackTab;

const TABS: Array<{ key: TabKey; label: string; Icon: typeof MessageSquare }> = [
  { key: 'voc', label: 'VOC', Icon: MessageSquare },
  { key: 'release-notes', label: '릴리즈 노트', Icon: ScrollText },
  { key: 'bug-fix-log', label: '버그 픽스 로그', Icon: Bug },
];

export const USER_FEEDBACK_TAB_TITLE: Record<TabKey, string> = {
  voc: '사용자 VOC 게시판',
  'release-notes': '릴리즈 노트',
  'bug-fix-log': '버그 픽스 로그',
};

interface Props {
  open: boolean;
  activeTab: TabKey;
  onTabChange: (tab: TabKey) => void;
}

export function UserFeedbackPanel({ open, activeTab, onTabChange }: Props) {
  const handleTabKeyDown = (e: React.KeyboardEvent, idx: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (idx + (e.key === 'ArrowRight' ? 1 : -1) + TABS.length) % TABS.length;
    onTabChange(TABS[next].key);
  };

  return (
    <div className="flex flex-col h-full">
      <div role="tablist" aria-label="사용자 피드백 보기" className="flex-shrink-0 flex items-center border-b border-border px-2">
        {TABS.map((t, idx) => (
          <button
            key={t.key}
            type="button"
            role="tab"
            aria-selected={activeTab === t.key}
            tabIndex={activeTab === t.key ? 0 : -1}
            onClick={() => onTabChange(t.key)}
            onKeyDown={(e) => handleTabKeyDown(e, idx)}
            className={cn(
              'flex items-center gap-1.5 px-3 py-2.5 text-sm border-b-2 -mb-px transition-colors',
              activeTab === t.key
                ? 'border-primary text-primary font-semibold'
                : 'border-transparent text-muted-foreground hover:text-foreground',
            )}
          >
            <t.Icon className="w-3.5 h-3.5" />
            {t.label}
          </button>
        ))}
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto">
        {activeTab === 'voc' && <VocBoardPanel open={open && activeTab === 'voc'} />}
        {activeTab === 'release-notes' && <ReleaseNotesPanel open={open && activeTab === 'release-notes'} />}
        {activeTab === 'bug-fix-log' && <BugFixLogPanel open={open && activeTab === 'bug-fix-log'} />}
      </div>
    </div>
  );
}
