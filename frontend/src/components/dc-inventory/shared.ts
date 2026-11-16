// DC 인벤토리 화면 공용 상수 — 버튼·입력 모양과 표시 문구.
import type { DcDeviceRole, DcDeviceStatus } from '@/types';

export const BTN = 'text-sm inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl border border-border bg-card text-foreground hover:bg-secondary disabled:opacity-40 disabled:cursor-not-allowed';
export const BTN_PRIMARY = 'text-sm font-medium inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed';
export const INPUT = 'text-sm px-3 py-1.5 rounded-xl border border-border bg-card text-foreground focus:outline-none focus:ring-1 focus:ring-primary';
export const TH = 'text-left text-xs font-semibold text-muted-foreground px-3 py-2 border-b border-border whitespace-nowrap';
export const TD = 'text-sm px-3 py-2 border-b border-border align-top';

export const ROLE_LABEL: Record<DcDeviceRole, string> = {
  server: '서버', leaf: 'leaf', spine: 'spine', 'super-spine': 'super-spine', 'fa-core': 'FA 코어', mgmt: 'mgmt', patch: '패치패널',
};
export const ROLE_OPTIONS: DcDeviceRole[] = ['server', 'leaf', 'spine', 'super-spine', 'fa-core', 'mgmt', 'patch'];

/** 정상(active)은 표시하지 않는다 — 상태 문구는 비정상일 때만(DESIGN_SYSTEM §12.12). */
export const STATUS_LABEL: Record<DcDeviceStatus, string> = {
  planned: '예정', active: '', spare: '예비', maintenance: '점검', decommission: '폐기',
};

/** 일괄 등록 시트 이름 → 화면 표기. */
export const SHEET_LABEL: Record<string, string> = {
  racks: '랙', device_types: '장비 종류', devices: '장비', interfaces: '인터페이스', cables: '케이블',
  prefixes: 'Prefix', ip_addresses: 'IP 주소', asns: 'ASN',
};

export const fmt = (n: number) => n.toLocaleString('ko-KR');
