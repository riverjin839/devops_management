/**
 * 담당자 관리 — 사용자 메뉴에서 호출되는 self-service 화면.
 * 라우트: `/me/assignees` (admin 전용이던 Settings 탭에서 분리, 로그인한 누구나 접근 가능)
 */
import { UserCheck } from 'lucide-react';
import { AssigneeManager } from '@/components/settings/AssigneeManager';

export function AssigneeManagePage() {
  return (
    <div className="min-h-screen bg-background">
      <main className="max-w-[1200px] mx-auto px-8 py-8">
        <div className="flex items-center gap-3 mb-6">
          <UserCheck className="w-6 h-6 text-primary" />
          <h1 className="text-xl font-bold">담당자 관리</h1>
        </div>
        <AssigneeManager />
      </main>
    </div>
  );
}
