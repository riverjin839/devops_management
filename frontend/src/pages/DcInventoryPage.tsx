// DC 인벤토리 (/dc-inventory) — 데이터센터 물리 구간(랙·장비·케이블·IPAM) 대장.
// 2단계 범위: 장비 목록(읽기) · Excel/CSV 일괄 등록 · 기존 데이터 연결.
// 랙 열 뷰(42U 배치도)·랙/장비 상세·경로 추적·생성/수정 폼은 3단계 — docs/dc-inventory/DESIGN.md §6.
// 클러스터 단위 화면이 아니므로 ClusterSidebar 를 쓰지 않는다.
import { Warehouse } from 'lucide-react';
import { PageHeader, PageShell, SegTabs } from '@/components/common';
import { DcDeviceTable, DcImportPanel, DcLinkPanel, DcServerImportPanel, DcTopologyBoard } from '@/components/dc-inventory';
import { fmt } from '@/components/dc-inventory/shared';
import { useDcOverview } from '@/hooks/useDcInventory';
import { pickParam, useUrlParam } from '@/hooks/useUrlParams';

const TABS = ['topology', 'devices', 'servers', 'import', 'link'] as const;
type Tab = (typeof TABS)[number];

export function DcInventoryPage() {
  const [tabParam, setTabParam] = useUrlParam('tab', 'topology');
  const tab = pickParam<Tab>(tabParam, TABS, 'topology');
  const overview = useDcOverview();
  const o = overview.data;

  return (
    <div className="app-min-h-screen bg-background flex">
      <PageShell density="hub" className="space-y-4">
        <PageHeader
          title="DC 인벤토리"
          icon={Warehouse}
          description={o ? (
            <>
              랙 {fmt(o.racks)} · 장비 {fmt(o.devices)} · 케이블 {fmt(o.cables)} · Prefix {fmt(o.prefixes)}
              {o.unrackedDevices > 0 && <> · 랙 미배정 장비 {fmt(o.unrackedDevices)}</>}
              {o.unlinkedExisting > 0 && (
                <>
                  {' · '}
                  <button type="button" className="text-primary hover:underline" onClick={() => setTabParam('link')}>
                    연결 안 된 기존 서버 {fmt(o.unlinkedExisting)}
                  </button>
                </>
              )}
            </>
          ) : '랙 · 장비 · 케이블 · 서브넷을 한 곳에서 관리합니다'}
        />
        <SegTabs<Tab>
          label="DC 인벤토리 보기"
          mode="tabs"
          size="md"
          value={tab}
          onChange={(v) => setTabParam(v)}
          options={[['topology', '토폴로지'], ['devices', '장비'], ['servers', '서버 일괄 등록'], ['import', '전체 양식 등록'], ['link', '기존 데이터 연결']]}
        />
        {tab === 'topology' && <DcTopologyBoard />}
        {tab === 'devices' && <DcDeviceTable onGoImport={() => setTabParam('servers')} />}
        {tab === 'servers' && <DcServerImportPanel />}
        {tab === 'import' && <DcImportPanel />}
        {tab === 'link' && <DcLinkPanel />}
      </PageShell>
    </div>
  );
}
