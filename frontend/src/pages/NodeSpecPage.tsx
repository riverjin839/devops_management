import { useEffect, useMemo, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ClipboardCheck, Plus, Search, RefreshCw, Download, Upload, Trash2, Pencil,
  Server, Cpu, HardDrive, MapPin, Square, Copy, ClipboardPaste, FileDown, Terminal,
  AlertTriangle, ScrollText, ChevronDown, ChevronUp,
} from 'lucide-react';
import { useClusters } from '@/hooks/useCluster';
import {
  ClusterSidebar, DebugLogPanel, ConfirmDialog, GridCell, InlineTextCell, useToast,
  SkeletonTable, EmptyState, ResizeGrip, DoubleScrollX, useModalA11y, LogViewer} from '@/components/common';
import { MacCard } from '@/components/ui/MacCard';
import { useColumnWidths } from '@/hooks/useColumnWidths';
import { formatApiError } from '@/lib/utils';
import { useAbortableMutation } from '@/hooks/useAbortableMutation';
import { useGridSelection } from '@/hooks/useGridSelection';
import { nodeSpecsApi } from '@/services/api';
import type { NodeServerSpec, NodeSpecStatus, NodeSpecHostFactsCollectResponse } from '@/types';
import { NodeSpecEditModal } from '@/components/node-specs/NodeSpecEditModal';
import { NodeSpecCsvUploadModal } from '@/components/node-specs/NodeSpecCsvUploadModal';
import { NodeSpecPasteModal } from '@/components/node-specs/NodeSpecPasteModal';
import { EXPORT_COLUMNS, NODE_SPEC_COLUMNS, serializeCellValue } from '@/components/node-specs/columns';

// 토큰 기반 — 테마 7종에서 깨지지 않도록 emerald/sky/amber/slate 고정 팔레트 대신
// --status-* 토큰을 쓴다. dot 색을 배지 클래스 문자열에서 split(' ')[0] 으로 뽑아내던
// 방식은 클래스 순서가 바뀌면 깨지는 취약한 패턴이라 별도 필드로 분리했다.
const STATUS_TONE: Record<string, { badge: string; dot: string }> = {
  active:       { badge: 'bg-status-healthy/10 text-status-healthy border-status-healthy/30', dot: 'bg-status-healthy' },
  spare:        { badge: 'bg-status-info/10 text-status-info border-status-info/30', dot: 'bg-status-info' },
  maintenance:  { badge: 'bg-status-warning/10 text-status-warning border-status-warning/30', dot: 'bg-status-warning' },
  decommission: { badge: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30', dot: 'bg-status-unknown' },
};
const DEFAULT_STATUS_TONE = { badge: 'bg-status-unknown/10 text-status-unknown border-status-unknown/30', dot: 'bg-status-unknown' };

const STATUS_LABEL: Record<string, string> = {
  active: '운영중', spare: '예비', maintenance: '점검', decommission: '폐기',
};

function StatusBadge({ status }: { status: string }) {
  const tone = STATUS_TONE[status] ?? DEFAULT_STATUS_TONE;
  return (
    <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded-full border ${tone.badge}`}>
      {STATUS_LABEL[status] ?? status}
    </span>
  );
}

interface HeaderMenuItem {
  icon: typeof Download;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  title?: string;
}

// 예전엔 CSV내보내기/템플릿/CSV업로드/붙여넣기/HostFacts/클러스터임포트가 전부 같은 줄에
// 색만 다르게(emerald/violet/indigo/sky) 나열돼 있었다 — 7개가 동일 비중으로 보여
// "신규 등록"(진짜 주 동작) 과 구분이 안 됐다. 성격별(내보내기/가져오기) 메뉴로 접어
// 인지 부하를 줄이고, 색은 다시 토큰으로 통일한다.
function HeaderMenu({ label, icon: Icon, items }: { label: string; icon: typeof Download; items: HeaderMenuItem[] }) {
  const [open, setOpen] = useState(false);
  const popRef = useModalA11y(open, () => setOpen(false));
  return (
    <div className="relative inline-block">
      <button
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        className="px-2.5 py-1 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg flex items-center gap-1"
      >
        <Icon className="w-3 h-3" /> {label}
        {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />}
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            ref={popRef}
            role="menu"
            aria-label={label}
            className="absolute z-50 top-full mt-1 left-0 min-w-[200px] bg-card border border-border rounded-lg shadow-xl py-1"
          >
            {items.map((it, i) => (
              <button
                key={i}
                role="menuitem"
                title={it.title}
                disabled={it.disabled}
                onClick={() => { it.onClick(); setOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-sm text-foreground hover:bg-secondary flex items-center gap-2 disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <it.icon className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" /> {it.label}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

/** OS 이미지 문자열을 짧게 — "Red Hat Enterprise Linux 9.4 (Plow)" → "RHEL 9.4". */
function shortOs(os: string): string {
  if (!os) return '';
  const trimmed = os.trim();
  let m = trimmed.match(/Red\s*Hat\s*Enterprise\s*Linux\s+(\d+(?:\.\d+)?)/i);
  if (m) return `RHEL ${m[1]}`;
  m = trimmed.match(/Rocky\s*Linux\s+(\d+(?:\.\d+)?)/i);
  if (m) return `Rocky ${m[1]}`;
  m = trimmed.match(/AlmaLinux\s+(\d+(?:\.\d+)?)/i);
  if (m) return `Alma ${m[1]}`;
  m = trimmed.match(/CentOS\s+(?:Linux\s+|Stream\s+)?(\d+(?:\.\d+)?)/i);
  if (m) return `CentOS ${m[1]}`;
  m = trimmed.match(/Ubuntu\s+(\d+\.\d+)/i);
  if (m) return `Ubuntu ${m[1]}`;
  m = trimmed.match(/Debian.*?(\d+(?:\.\d+)?)/i);
  if (m) return `Debian ${m[1]}`;
  m = trimmed.match(/Oracle\s*Linux\s+(?:Server\s+)?(\d+(?:\.\d+)?)/i);
  if (m) return `Oracle ${m[1]}`;
  m = trimmed.match(/Photon\s*OS\s+(\d+(?:\.\d+)?)/i);
  if (m) return `Photon ${m[1]}`;
  // 짧은 문자열은 그대로, 긴 건 처음 20자만.
  return trimmed.length <= 20 ? trimmed : `${trimmed.slice(0, 20)}…`;
}

function csvEscape(s: string): string {
  if (/[",\n]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function exportCsv(rows: NodeServerSpec[]) {
  const cols = EXPORT_COLUMNS;
  const header = cols.map((c) => c.csvKey).join(',');
  const body = rows.map((r) =>
    cols.map((c) => csvEscape(serializeCellValue(r[c.field], c))).join(','),
  ).join('\n');
  const csv = `${header}\n${body}\n`;
  const blob = new Blob(['﻿', csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  const today = new Date().toISOString().slice(0, 10);
  a.href = url;
  a.download = `node-server-specs-${today}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadCsvTemplate() {
  const header = EXPORT_COLUMNS.map((c) => c.csvKey).join(',');
  const example = EXPORT_COLUMNS.map((c) => {
    if (c.field === 'hostname') return 'srv-master-01';
    if (c.field === 'osImage') return 'Red Hat Enterprise Linux 9.4';
    if (c.field === 'diskTotalGb') return '1920';
    if (c.field === 'nonOsDiskGb') return '1820';
    if (c.field === 'diskType') return 'NVMe (nvme0n1)';
    if (c.field === 'bond0Ip') return '10.0.10.21';
    if (c.field === 'bond1Ip') return '192.168.10.21';
    if (c.field === 'isSsd') return 'O';
    if (c.field === 'isVm') return 'X';
    if (c.field === 'currentUsage') return 'NEW K8S MASTER';
    return '';
  }).join(',');
  const blob = new Blob(['﻿', `${header}\n${example}\n`], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'node-server-specs-template.csv';
  a.click();
  URL.revokeObjectURL(url);
}

export function NodeSpecPage() {
  const { data: clusters = [] } = useClusters();
  const qc = useQueryClient();
  const toast = useToast();

  const [clusterId, setClusterId] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<NodeSpecStatus | ''>('');
  const [roleFilter, setRoleFilter] = useState('');
  const [search, setSearch] = useState('');

  const [editTarget, setEditTarget] = useState<NodeServerSpec | null>(null);
  const [creating, setCreating] = useState(false);
  const [confirmImport, setConfirmImport] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<NodeServerSpec | null>(null);
  const [csvOpen, setCsvOpen] = useState(false);
  const [pasteOpen, setPasteOpen] = useState(false);
  const [hostFactsOpen, setHostFactsOpen] = useState(false);
  const [collectingFacts, setCollectingFacts] = useState(false);
  const [sshUser, setSshUser] = useState('root');
  const [sshPassword, setSshPassword] = useState('');
  const [sshPrivateKey, setSshPrivateKey] = useState('');
  const [hostList, setHostList] = useState('');
  const [useSudo, setUseSudo] = useState(false);
  const [selectedHosts, setSelectedHosts] = useState<string[]>([]);
  const [confirmHostFacts, setConfirmHostFacts] = useState(false);
  // 실행 결과 — 건수 토스트만으로는 "어느 호스트가 왜 실패했는지" 알 수 없다.
  // CLAUDE.md 필수 규칙(모든 "실행" 버튼은 상세 로그 + 사용자가 켜고 끄는 로그 보기)에 따라
  // 호스트별 상세를 로그 형태로 남기고 접었다 펼 수 있게 한다.
  const [hostFactsResult, setHostFactsResult] = useState<NodeSpecHostFactsCollectResponse | null>(null);
  const [hostFactsLogOpen, setHostFactsLogOpen] = useState(false);
  // Host Facts 수집 모달 접근성 (Escape·포커스 트랩·초점 복원). 수집 중엔 닫기 무시.
  const closeHostFacts = () => {
    setHostFactsOpen(false);
    setHostFactsResult(null);
    setHostFactsLogOpen(false);
  };
  const hostFactsRef = useModalA11y(hostFactsOpen, () => { if (!collectingFacts) closeHostFacts(); });

  const listQ = useQuery({
    queryKey: ['node-specs', clusterId, statusFilter, roleFilter, search],
    queryFn: ({ signal }) => nodeSpecsApi.list({
      clusterId: clusterId || undefined,
      status: statusFilter || undefined,
      role: roleFilter || undefined,
      search: search.trim() || undefined,
    }, signal).then((r) => r.data),
  });
  const rows: NodeServerSpec[] = useMemo(() => listQ.data?.data ?? [], [listQ.data]);

  // ── Grid 블록 선택 + 복사 ────────────────────────────────────────────
  const tableRef = useRef<HTMLDivElement>(null);
  // 사용자 요청 반영 (자산 / vendor / GPU 항목 제거, CPU·RAM 분리, IP→public/private bond 분리)
  const GRID_COLS = useMemo(() => [
    'hostname', 'status', 'cluster', 'publicIp', 'privateIp',
    'cpu', 'ram', 'disk', 'os', 'ssd', 'vm', 'currentUsage', 'location',
  ], []);
  const rowIds = useMemo(() => rows.map((r) => r.id), [rows]);

  // 컬럼 너비 (드래그로 조정, localStorage 영속화)
  const COL_LABELS: Record<string, string> = {
    hostname: '호스트명', status: '상태', cluster: '클러스터/역할',
    publicIp: 'public IP (bond0)', privateIp: 'private IP (bond1)',
    cpu: 'CPU', ram: 'RAM', disk: 'DISK', os: 'OS',
    ssd: 'SSD', vm: 'VM', currentUsage: '현재 용도', location: '위치',
  };
  const COL_TIPS: Record<string, string> = {
    hostname: 'OS hostname (등록 시 입력 또는 클러스터 임포트로 자동수집)',
    status: '운영중 / 예비 / 점검 / 폐기 — 자산 운용 상태',
    cluster: '소속 클러스터 + k8s 역할 (control-plane / worker / etcd / spare)',
    publicIp: '공인망 IP — node 의 ip addr 출력에서 bond0 에 할당된 IP. NIC 수집(SSH) 으로 자동 채워짐.',
    privateIp: '내부망 IP — node 의 ip addr 출력에서 bond1 에 할당된 IP.',
    cpu: 'CPU 모델 + 소켓/코어/스레드. 클러스터 임포트 시 logical thread 만 자동수집되고 sockets/cores 는 수기 입력.',
    ram: '메모리 총량(GB) + 모듈 구성 (예: 16x64GB DDR4-3200).',
    disk: 'DISK 총용량 + OS 디스크 제외 사용 가능 용량 + 종류(NVMe/SSD/HDD). lsblk -o NAME,MODEL,TRAN,ROTA 로 SSD/NVMe 구분.',
    os: 'OS 이미지 — 길어서 RHEL9.4, Rocky 8.8 형식으로 축약 표기. 커널 버전은 그 아래.',
    ssd: 'SSD 여부 (자동수집: NVMe 또는 비회전 디스크 발견 시 O). lsblk TRAN 컬럼 기반.',
    vm: 'VM 여부 (수기 입력). VM 이면 O, bare-metal 이면 X.',
    currentUsage: '이 노드의 현재 용도 (예: NEW K8S MASTER, GPU 워크로드).',
    location: '데이터센터 / Room / Rack / U — 물리 위치.',
  };
  const colW = useColumnWidths('node-spec-table-v2', {
    defaults: {
      hostname: 140, status: 80, cluster: 120,
      publicIp: 140, privateIp: 140,
      cpu: 130, ram: 110, disk: 160, os: 130,
      ssd: 70, vm: 60, currentUsage: 160, location: 140, actions: 80,
    },
    min: 60, max: 600,
  });

  const cellText = (coord: { row: string; col: string }): string | undefined => {
    const r = rows.find((x) => x.id === coord.row);
    if (!r) return undefined;
    switch (coord.col) {
      case 'hostname': return r.hostname;
      case 'status': return r.status;
      case 'cluster': return `${r.clusterName ?? ''}${r.role ? ` (${r.role})` : ''}`;
      case 'publicIp': return r.bond0Ip ?? '';
      case 'privateIp': return r.bond1Ip ?? '';
      case 'cpu': return `${r.cpuSockets ?? ''}s/${r.cpuCores ?? ''}c/${r.cpuThreads ?? ''}t ${r.cpuModel ?? ''}`.trim();
      case 'ram': return `${r.memoryGb ?? ''}GB ${r.memoryModules ?? ''}`.trim();
      case 'disk': return `${r.diskTotalGb ?? ''}GB / non-OS ${r.nonOsDiskGb ?? '-'}GB ${r.diskType ?? ''}`.trim();
      case 'os': return r.osImage ?? '';
      case 'ssd': return r.diskType ?? (r.isSsd === true ? 'O' : r.isSsd === false ? 'X' : '-');
      case 'vm': return r.isVm === true ? 'O' : r.isVm === false ? 'X' : '-';
      case 'currentUsage': return r.currentUsage ?? '';
      case 'location': return [r.datacenter, r.room, r.rack, r.rackUnit].filter(Boolean).join('/');
      default: return '';
    }
  };

  const selection = useGridSelection({
    rowIds,
    colKeys: GRID_COLS,
    getCellText: cellText,
    containerRef: tableRef,
  });

  // ── 전역 paste — 테이블 내 셀이 선택된 상태에서 Ctrl+V 하면 붙여넣기 모달 ──
  const [pasteInitialText, setPasteInitialText] = useState<string>('');
  useEffect(() => {
    const handler = (e: ClipboardEvent) => {
      // 편집 중인 input/textarea 에 붙여넣는 건 건드리지 않음
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA' || tgt.isContentEditable)) return;
      // 현재 페이지에 있을 때만 (테이블 또는 body 포커스)
      const active = document.activeElement;
      const inTable = active && (active === document.body || tableRef.current?.contains(active));
      if (!inTable) return;
      const txt = e.clipboardData?.getData('text/plain') ?? '';
      if (!txt.trim() || (!txt.includes('\t') && !txt.includes(','))) return;
      e.preventDefault();
      setPasteInitialText(txt);
      setPasteOpen(true);
    };
    window.addEventListener('paste', handler);
    return () => window.removeEventListener('paste', handler);
  }, []);

  // 인라인 셀 편집 저장
  // SSD/VM 순환 토글처럼 클릭이 겹칠 수 있는 필드는 저장 중 재클릭을 막는다 —
  // 안 막으면 두 클릭 모두 같은(아직 갱신 안 된) 값을 기준으로 "다음 값"을 계산해
  // 순환이 한 칸만 움직이고 요청은 중복으로 나간다.
  const [savingKeys, setSavingKeys] = useState<Set<string>>(new Set());
  const saveField = async (id: string, patch: Partial<NodeServerSpec>) => {
    const keys = Object.keys(patch).map((f) => `${id}:${f}`);
    setSavingKeys((s) => new Set([...s, ...keys]));
    try {
      await nodeSpecsApi.update(id, patch);
      qc.invalidateQueries({ queryKey: ['node-specs'] });
    } catch (e: unknown) {
      toast.error('저장 실패', formatApiError(e));
    } finally {
      setSavingKeys((s) => {
        const next = new Set(s);
        keys.forEach((k) => next.delete(k));
        return next;
      });
    }
  };

  const stats = useMemo(() => {
    const c: Record<string, number> = { total: rows.length, active: 0, spare: 0, maintenance: 0, decommission: 0 };
    rows.forEach((r) => { c[r.status] = (c[r.status] ?? 0) + 1; });
    return c;
  }, [rows]);

  // 전체 서버(클러스터) 기준 CPU(논리 코어)·메모리(GB) 총합.
  // cpuThreads(HT 포함 논리 CPU) 우선, 없으면 sockets×cores 로 환산.
  const totals = useMemo(() => {
    let cpu = 0;
    let memGb = 0;
    rows.forEach((r) => {
      const threads = r.cpuThreads ?? (((r.cpuSockets ?? 0) * (r.cpuCores ?? 0)) || 0);
      cpu += threads;
      memGb += r.memoryGb ?? 0;
    });
    return { cpu, memGb };
  }, [rows]);
  const memLabel = totals.memGb >= 1024
    ? `${(totals.memGb / 1024).toFixed(1)} TB`
    : `${totals.memGb.toLocaleString()} GB`;

  const importMut = useAbortableMutation({
    mutationFn: async (_: void, signal) => {
      if (!clusterId) throw new Error('클러스터를 먼저 선택하세요.');
      return (await nodeSpecsApi.importFromCluster(clusterId, { upsert: true }, signal)).data;
    },
    onSuccess: (data) => {
      qc.invalidateQueries({ queryKey: ['node-specs'] });
      toast.success(
        '클러스터 임포트 완료',
        `신규 ${data.inserted} · 업데이트 ${data.updated} · 변경없음 ${data.skipped}` +
        (data.errors.length ? ` · 오류 ${data.errors.length}건` : ''),
      );
    },
    onError: (e: unknown) => {
      toast.error('임포트 실패', formatApiError(e));
    },
  });

  const handleDelete = async () => {
    if (!confirmDelete) return;
    try {
      const hostname = confirmDelete.hostname;
      await nodeSpecsApi.delete(confirmDelete.id);
      qc.invalidateQueries({ queryKey: ['node-specs'] });
      setConfirmDelete(null);
      toast.success('서버스펙 삭제됨', hostname);
    } catch (e) {
      toast.error('삭제 실패', formatApiError(e));
    }
  };

  const hostFactsHosts = useMemo(() => {
    const manualHosts = hostList.split(/[\n,\s]+/).map((h) => h.trim()).filter(Boolean);
    return Array.from(new Set([...selectedHosts, ...manualHosts]));
  }, [hostList, selectedHosts]);

  const handleCollectHostFacts = async () => {
    if (!clusterId) return;
    const hosts = hostFactsHosts;
    if (hosts.length === 0) {
      toast.warning('호스트 목록 필요', 'IP/hostname 을 1개 이상 입력하세요.');
      return;
    }
    if (!sshPassword && !sshPrivateKey.trim()) {
      toast.warning('인증정보 필요', 'password 또는 private key 중 하나는 필수입니다.');
      return;
    }
    setCollectingFacts(true);
    setHostFactsResult(null);
    try {
      const res = await nodeSpecsApi.collectHostFacts(clusterId, {
        hosts,
        username: sshUser || 'root',
        password: sshPassword || undefined,
        privateKey: sshPrivateKey.trim() || undefined,
        useSudo,
        upsert: true,
      });
      qc.invalidateQueries({ queryKey: ['node-specs'] });
      toast.success('Host Facts 수집 완료', `신규 ${res.data.inserted} · 업데이트 ${res.data.updated} · 스킵 ${res.data.skipped}`);
      if (res.data.errors.length > 0) toast.warning('일부 오류', `${res.data.errors.length}건 — 아래 상세 로그를 확인하세요.`);
      // 성공/실패와 무관하게 모달은 열어둔다 — 자동으로 닫히면 방금 뭐가 실패했는지 볼 기회가 없다.
      setHostFactsResult(res.data);
      if (res.data.errors.length > 0) setHostFactsLogOpen(true);
    } catch (e: unknown) {
      toast.error('Host Facts 수집 실패', formatApiError(e));
    } finally {
      setCollectingFacts(false);
    }
  };

  // 호스트별 상세 — "실행" 버튼의 결과를 건수 토스트 하나로 뭉개지 않고 로그로 남긴다.
  function buildHostFactsLog(res: NodeSpecHostFactsCollectResponse): string {
    return res.items.map((it) => {
      const parts = [`[${it.status}]`, it.host];
      if (it.message) parts.push(`— ${it.message}`);
      if (it.status === 'updated') {
        const facts: string[] = [];
        if (it.bond0Ip) facts.push(`bond0=${it.bond0Ip}`);
        if (it.bond1Ip) facts.push(`bond1=${it.bond1Ip}`);
        if (it.diskTotalGb != null) facts.push(`disk=${it.diskTotalGb}GB`);
        if (it.diskType) facts.push(`type=${it.diskType}`);
        if (it.isSsd != null) facts.push(`ssd=${it.isSsd ? 'O' : 'X'}`);
        if (it.isVm != null) facts.push(`vm=${it.isVm ? 'O' : 'X'}`);
        if (facts.length) parts.push(`(${facts.join(', ')})`);
      }
      return parts.join(' ');
    }).join('\n');
  }

  const clusterNodeCandidates = useMemo(() => {
    const c = clusters.find((x) => x.id === clusterId);
    if (!c?.nodeIps) return [];
    try {
      const parsed = JSON.parse(c.nodeIps) as Array<{ name?: string; ip?: string; ips?: string[] }>;
      const vals = parsed.flatMap((n) => [n.name, n.ip, ...(n.ips ?? [])]).filter(Boolean) as string[];
      return Array.from(new Set(vals));
    } catch {
      return [];
    }
  }, [clusters, clusterId]);

  return (
    <div className="app-min-h-screen bg-background">
      <main className="pr-3 py-3 flex gap-3">
        <ClusterSidebar
          clusters={clusters}
          selectedId={clusterId}
          onSelect={setClusterId}
          allowAll
          allLabel="전체 (등록 + 미배정)"
          iconOnly
        />

        <div className="flex-1 min-w-0">
          <DebugLogPanel pageKey="node-specs" extra={{ clusterId, total: rows.length, statusFilter, roleFilter, search }} />

          {/* 헤더 */}
          <div className="flex items-center gap-3 mb-2">
            <ClipboardCheck className="w-6 h-6 text-primary" />
            <h1 className="text-xl font-bold">노드 서버스펙 관리 대장</h1>
            <span className="text-sm px-2 py-0.5 rounded-full bg-secondary text-muted-foreground border border-border">
              {stats.total} 건
            </span>
            <div className="ml-auto flex items-center gap-1.5">
              <HeaderMenu label="내보내기" icon={Download} items={[
                { icon: Download, label: 'CSV 내보내기', onClick: () => exportCsv(rows), disabled: rows.length === 0 },
                { icon: FileDown, label: '템플릿 다운로드', onClick: downloadCsvTemplate, title: '현재 테이블 컬럼 기준 빈 템플릿 다운로드' },
              ]} />
              <HeaderMenu label="가져오기" icon={Upload} items={[
                { icon: Upload, label: 'CSV 업로드', onClick: () => setCsvOpen(true) },
                { icon: ClipboardPaste, label: '엑셀 붙여넣기', onClick: () => setPasteOpen(true), title: '엑셀/구글시트에서 복사한 블록 붙여넣기' },
                ...(clusterId ? [{
                  icon: Terminal, label: 'Host Facts 수집 (SSH)',
                  onClick: () => { setSelectedHosts(clusterNodeCandidates); setHostFactsResult(null); setHostFactsLogOpen(false); setHostFactsOpen(true); },
                }] : []),
                ...(clusterId ? [{
                  icon: RefreshCw, label: '클러스터 임포트 (kubeconfig)',
                  onClick: () => setConfirmImport(true), disabled: importMut.isPending,
                }] : []),
              ]} />
              {clusterId && importMut.isPending && (
                <button onClick={importMut.abort}
                  className="px-2.5 py-1 text-sm font-medium bg-destructive hover:bg-destructive/90 text-destructive-foreground rounded-lg flex items-center gap-1">
                  <Square className="w-3 h-3 fill-current" /> 중지
                </button>
              )}
              <button onClick={() => setCreating(true)}
                className="px-3 py-1 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> 신규 등록
              </button>
            </div>
          </div>

          {/* 통계 pills + 필터 + 전체 합계 — 한 줄로 통합 (pills 클릭 시 상태 필터 연동) */}
          <div className="flex flex-wrap items-center gap-1.5 mb-3">
            {(['total', 'active', 'spare', 'maintenance', 'decommission'] as const).map((k) => {
              const isActive = k === 'total' ? statusFilter === '' : statusFilter === k;
              const dotCls = k === 'total' ? '' : (STATUS_TONE[k] ?? DEFAULT_STATUS_TONE).dot;
              return (
                <button
                  key={k}
                  onClick={() => setStatusFilter(k === 'total' ? '' : k as NodeSpecStatus)}
                  className={`inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full border text-xs transition-colors ${
                    isActive
                      ? 'bg-primary/10 border-primary/50 text-primary'
                      : 'bg-card border-border hover:border-primary/40 text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {k !== 'total' && (
                    <span className={`w-1.5 h-1.5 rounded-full inline-block ${dotCls}`} />
                  )}
                  <span>{k === 'total' ? '전체' : STATUS_LABEL[k]}</span>
                  <span className="font-bold tabular-nums text-foreground">{stats[k] ?? 0}</span>
                </button>
              );
            })}

            {/* 필터 (작게) — 검색 / 상태 / 역할 */}
            <div className="relative min-w-[180px]">
              <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)}
                placeholder="hostname / serial / IP / model"
                className="w-full pl-7 pr-2 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
              />
            </div>
            <select value={statusFilter} onChange={(e) => setStatusFilter(e.target.value as NodeSpecStatus | '')}
              className="px-1.5 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="">상태 전체</option>
              <option value="active">운영중</option>
              <option value="spare">예비</option>
              <option value="maintenance">점검</option>
              <option value="decommission">폐기</option>
            </select>
            <select value={roleFilter} onChange={(e) => setRoleFilter(e.target.value)}
              className="px-1.5 py-1 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary">
              <option value="">역할 전체</option>
              <option value="control-plane">control-plane</option>
              <option value="worker">worker</option>
              <option value="etcd">etcd</option>
              <option value="storage">storage</option>
              <option value="spare">spare</option>
              <option value="ingress">ingress</option>
            </select>

            {/* 전체 서버 기준 CPU·MEM 총합 — 맨 우측 */}
            <div className="ml-auto flex items-center gap-2 text-xs">
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary border border-border tabular-nums"
                title="전체 서버 논리 CPU(스레드) 합계">
                <Cpu className="w-3 h-3 text-muted-foreground" />
                <span className="font-bold text-foreground">{totals.cpu.toLocaleString()}</span>
                <span className="text-muted-foreground">vCPU</span>
              </span>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-secondary border border-border tabular-nums"
                title="전체 서버 메모리 합계">
                <HardDrive className="w-3 h-3 text-muted-foreground" />
                <span className="font-bold text-foreground">{memLabel}</span>
              </span>
            </div>
          </div>

          {/* 선택 상태 표시 */}
          {selection.rangeSize > 0 && (
            <div className="flex items-center gap-2 px-3 py-1.5 mb-2 bg-primary/5 border border-primary/30 rounded-lg text-xs">
              <Copy className="w-3 h-3 text-primary" />
              <span className="text-primary font-medium">{selection.rangeSize}개 셀 선택됨</span>
              <span className="text-muted-foreground">
                · Ctrl+C (Cmd+C) 로 TSV 복사 · Esc 로 해제
              </span>
              <button onClick={selection.clear}
                className="ml-auto text-muted-foreground hover:text-foreground">
                해제
              </button>
            </div>
          )}

          {/* 테이블 */}
          <MacCard bodyPadding="p-0" rootClassName="overflow-hidden">
          <div ref={tableRef} tabIndex={-1}>
            <DoubleScrollX>
              <table className="text-sm" style={{ tableLayout: 'fixed', width: 'max-content', minWidth: '100%' }}>
                <colgroup>
                  {GRID_COLS.map((k) => <col key={k} style={{ width: `${colW.getWidth(k)}px` }} />)}
                  <col style={{ width: `${colW.getWidth('actions')}px` }} />
                </colgroup>
                <thead className="bg-muted/30 text-left sticky top-0">
                  <tr className="border-b border-border">
                    {GRID_COLS.map((k) => (
                      <th key={k}
                        title={COL_TIPS[k] ?? COL_LABELS[k]}
                        className={`relative px-2 py-2 text-xs font-semibold text-muted-foreground ${k === 'ssd' || k === 'vm' ? 'text-center' : ''}`}>
                        <span className="truncate inline-flex items-center gap-1 max-w-full align-middle cursor-help">
                          {COL_LABELS[k]}
                          <span className="text-[10px] text-muted-foreground/50">ⓘ</span>
                        </span>
                        <ResizeGrip onMouseDown={(e) => colW.beginResize(k, e)} onDoubleClick={() => colW.autoFit(k)} />
                      </th>
                    ))}
                    <th className="relative px-2 py-2 text-xs font-semibold text-muted-foreground">
                      <ResizeGrip onMouseDown={(e) => colW.beginResize('actions', e)} onDoubleClick={() => colW.autoFit('actions')} />
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {listQ.isLoading && <SkeletonTable rows={6} columns={GRID_COLS.length + 1} />}
                  {/* 실패도 "빈 목록"과 똑같이 보이면 사용자는 서버에 정말 아무 것도 없다고
                      오해한다 — 실패와 빈 상태를 반드시 구분해서 보여준다. */}
                  {!listQ.isLoading && listQ.isError && (
                    <tr><td colSpan={GRID_COLS.length + 1} className="p-0">
                      <EmptyState
                        icon={AlertTriangle}
                        title="목록을 불러오지 못했습니다"
                        description={formatApiError(listQ.error)}
                        action={{ label: '다시 시도', onClick: () => listQ.refetch() }}
                      />
                    </td></tr>
                  )}
                  {!listQ.isLoading && !listQ.isError && rows.length === 0 && (
                    <tr><td colSpan={GRID_COLS.length + 1} className="p-0">
                      <EmptyState
                        icon={ClipboardCheck}
                        title="등록된 서버가 없습니다"
                        description="kubeconfig 가 등록된 클러스터라면 '클러스터 임포트' 로 자동 생성 가능합니다."
                        action={{ label: '신규 등록', onClick: () => setCreating(true) }}
                        secondaryAction={clusterId ? { label: '클러스터 임포트', onClick: () => setConfirmImport(true) } : undefined}
                      />
                    </td></tr>
                  )}
                  {!listQ.isError && rows.map((r) => (
                    <tr key={r.id} className="border-b border-border hover:bg-muted/10">
                      <GridCell row={r.id} col="hostname" selection={selection}
                        className="px-2 py-2 font-mono text-sm text-foreground align-top">
                        <p className="font-semibold">{r.hostname}</p>
                        {r.nodeName && r.nodeName !== r.hostname && (
                          <p className="text-xs text-muted-foreground">k8s: {r.nodeName}</p>
                        )}
                      </GridCell>
                      <GridCell row={r.id} col="status" selection={selection}
                        className="px-2 py-2 align-top">
                        <StatusBadge status={r.status} />
                      </GridCell>
                      <GridCell row={r.id} col="cluster" selection={selection}
                        className="px-2 py-2 align-top">
                        <p className="text-sm">{r.clusterName ?? <span className="text-muted-foreground/60">미배정</span>}</p>
                        <p className="text-xs text-muted-foreground">{r.role ?? '-'}</p>
                      </GridCell>
                      <GridCell row={r.id} col="publicIp" selection={selection}
                        className="px-2 py-2 align-top font-mono text-xs">
                        {r.bond0Ip ? (
                          <p className="text-foreground" title="ip addr → bond0 의 IP">
                            <InlineTextCell value={r.bond0Ip} placeholder="bond0 IP"
                              onSave={(v) => saveField(r.id, { bond0Ip: v })} />
                          </p>
                        ) : (
                          <span className="text-muted-foreground/50 italic" title="NIC 수집(SSH) 후 자동 채워지거나 수기 입력">
                            미수집
                          </span>
                        )}
                        {r.bond0Speed && <p className="text-xs text-muted-foreground">{r.bond0Speed}</p>}
                      </GridCell>
                      <GridCell row={r.id} col="privateIp" selection={selection}
                        className="px-2 py-2 align-top font-mono text-xs">
                        {r.bond1Ip ? (
                          <p className="text-foreground" title="ip addr → bond1 의 IP">
                            <InlineTextCell value={r.bond1Ip} placeholder="bond1 IP"
                              onSave={(v) => saveField(r.id, { bond1Ip: v })} />
                          </p>
                        ) : (
                          <span className="text-muted-foreground/50 italic" title="NIC 수집(SSH) 후 자동 채워지거나 수기 입력">
                            미수집
                          </span>
                        )}
                        {r.bond1Speed && <p className="text-xs text-muted-foreground">{r.bond1Speed}</p>}
                      </GridCell>
                      <GridCell row={r.id} col="cpu" selection={selection}
                        className="px-2 py-2 align-top text-sm">
                        <p className="font-mono">
                          <Cpu className="w-3 h-3 inline mr-0.5 text-muted-foreground" />
                          {r.cpuSockets ? `${r.cpuSockets}s · ` : ''}
                          {r.cpuCores != null ? `${r.cpuCores}c` : '?'}
                          {r.cpuThreads ? `/${r.cpuThreads}t` : ''}
                        </p>
                        <p className="text-muted-foreground text-xs truncate max-w-[180px]" title={r.cpuModel ?? ''}>
                          {r.cpuModel ?? '-'}
                        </p>
                      </GridCell>
                      <GridCell row={r.id} col="ram" selection={selection}
                        className="px-2 py-2 align-top text-sm">
                        <p className="font-mono">
                          {r.memoryGb ? `${r.memoryGb}GB` : '-'}
                        </p>
                        {r.memoryModules && (
                          <p className="text-xs text-muted-foreground truncate max-w-[160px]" title={r.memoryModules}>
                            {r.memoryModules}
                          </p>
                        )}
                      </GridCell>
                      <GridCell row={r.id} col="disk" selection={selection}
                        className="px-2 py-2 align-top text-sm">
                        <p className="font-mono">
                          <HardDrive className="w-3 h-3 inline mr-0.5 text-muted-foreground" />
                          {r.diskTotalGb ? `총 ${r.diskTotalGb}GB` : '-'}
                          {r.diskCount ? ` ×${r.diskCount}` : ''}
                        </p>
                        <p className="text-xs text-muted-foreground" title="OS 디스크 제외한 사용 가능 디스크 합계 (lsblk 자동수집 또는 수기)">
                          OS 제외 {r.nonOsDiskGb != null ? `${r.nonOsDiskGb}GB` : '-'}
                        </p>
                        {r.diskType && (
                          <p className="text-xs font-mono text-status-info/80 truncate max-w-[180px]" title={r.diskType}>
                            {r.diskType}
                          </p>
                        )}
                      </GridCell>
                      <GridCell row={r.id} col="os" selection={selection}
                        className="px-2 py-2 align-top text-sm font-mono max-w-[160px]">
                        <p className="truncate font-semibold" title={r.osImage ?? ''}>
                          {shortOs(r.osImage ?? '') || (
                            <InlineTextCell value="" placeholder="OS" onSave={(v) => saveField(r.id, { osImage: v })} />
                          )}
                        </p>
                        {r.kernelVersion && (
                          <p className="text-xs text-muted-foreground truncate" title={r.kernelVersion}>
                            {r.kernelVersion}
                          </p>
                        )}
                      </GridCell>
                      <GridCell row={r.id} col="ssd" selection={selection}
                        className="px-2 py-2 align-top text-center">
                        <div className="flex flex-col items-center gap-0.5 text-sm font-mono">
                          <button
                            type="button"
                            title="SSD 여부 (클릭 순환: 미설정 → O → X → 미설정)"
                            aria-label={`SSD 여부: ${r.isSsd === true ? '예' : r.isSsd === false ? '아니오' : '미설정'} — 클릭하여 순환 변경`}
                            aria-pressed={r.isSsd === true ? 'true' : r.isSsd === false ? 'false' : 'mixed'}
                            disabled={savingKeys.has(`${r.id}:isSsd`)}
                            onClick={() => {
                              const next = r.isSsd === true ? false : r.isSsd === false ? null : true;
                              saveField(r.id, { isSsd: next });
                            }}
                            className={`px-1 rounded hover:bg-primary/10 disabled:opacity-40 ${
                              r.isSsd === true ? 'text-status-healthy font-bold'
                              : r.isSsd === false ? 'text-muted-foreground/50'
                              : 'text-muted-foreground/30'
                            }`}
                          >
                            {r.isSsd === true ? 'O' : r.isSsd === false ? 'X' : '·'}
                          </button>
                          {r.diskType && (
                            <span className="text-xs text-muted-foreground truncate max-w-full" title={r.diskType}>
                              {r.diskType}
                            </span>
                          )}
                        </div>
                      </GridCell>
                      <GridCell row={r.id} col="vm" selection={selection}
                        className="px-2 py-2 align-top text-center">
                        <button
                          type="button"
                          title="VM 여부 (클릭 순환: 미설정 → O → X → 미설정)"
                          aria-label={`VM 여부: ${r.isVm === true ? '예' : r.isVm === false ? '아니오' : '미설정'} — 클릭하여 순환 변경`}
                          aria-pressed={r.isVm === true ? 'true' : r.isVm === false ? 'false' : 'mixed'}
                          disabled={savingKeys.has(`${r.id}:isVm`)}
                          onClick={() => {
                            const next = r.isVm === true ? false : r.isVm === false ? null : true;
                            saveField(r.id, { isVm: next });
                          }}
                          className={`px-1 rounded text-sm font-mono hover:bg-primary/10 disabled:opacity-40 ${
                            r.isVm === true ? 'text-status-info font-bold'
                            : r.isVm === false ? 'text-muted-foreground/50'
                            : 'text-muted-foreground/30'
                          }`}
                        >
                          {r.isVm === true ? 'O' : r.isVm === false ? 'X' : '·'}
                        </button>
                      </GridCell>
                      <GridCell row={r.id} col="currentUsage" selection={selection}
                        className="px-2 py-2 align-top text-sm max-w-[160px]">
                        <p className="font-medium truncate" title={r.currentUsage ?? ''}>
                          <InlineTextCell value={r.currentUsage ?? ''} placeholder="NEW K8S MASTER"
                            onSave={(v) => saveField(r.id, { currentUsage: v })} />
                        </p>
                      </GridCell>
                      <GridCell row={r.id} col="location" selection={selection}
                        className="px-2 py-2 align-top text-sm">
                        {(r.datacenter || r.rack || r.rackUnit) ? (
                          <p className="font-mono text-foreground">
                            <MapPin className="w-3 h-3 inline mr-0.5 text-muted-foreground" />
                            {[r.datacenter, r.room, r.rack, r.rackUnit].filter(Boolean).join('/')}
                          </p>
                        ) : <span className="text-muted-foreground/60">-</span>}
                      </GridCell>
                      <td className="px-2 py-2 align-top">
                        <div className="flex items-center gap-1">
                          <button onClick={() => setEditTarget(r)} title="상세 수정 (모달)" aria-label="상세 수정 (모달)"
                            className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button onClick={() => setConfirmDelete(r)} title="삭제" aria-label="삭제"
                            className="p-1 rounded hover:bg-red-500/10 text-muted-foreground hover:text-red-400">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </DoubleScrollX>
          </div>
          </MacCard>

          <p className="text-xs text-muted-foreground mt-2 flex items-center gap-1">
            <Server className="w-3 h-3" />
            "클러스터 임포트" 는 kubeconfig 로 hostname / IP / CPU / RAM / OS / kernel 등을 자동 채웁니다.
            벤더/시리얼/랙/자산태그 등은 수기로 입력하세요.
          </p>
        </div>
      </main>

      {(editTarget || creating) && (
        <NodeSpecEditModal
          mode={creating ? 'create' : 'edit'}
          spec={editTarget}
          defaultClusterId={clusterId}
          clusters={clusters}
          onClose={() => { setEditTarget(null); setCreating(false); }}
          onSaved={() => {
            qc.invalidateQueries({ queryKey: ['node-specs'] });
            setEditTarget(null);
            setCreating(false);
          }}
        />
      )}

      <ConfirmDialog
        open={confirmImport}
        title="클러스터 노드 임포트"
        description="kubeconfig 로 노드 메타데이터를 가져와 신규 등록 또는 자동수집 필드만 갱신합니다 (벤더/자산태그 등은 보존)."
        onCancel={() => setConfirmImport(false)}
        onConfirm={() => { setConfirmImport(false); importMut.mutate(); }}
      >
        <div className="space-y-1 font-mono text-xs text-muted-foreground">
          <div>cluster: {clusters.find((c) => c.id === clusterId)?.name ?? clusterId}</div>
          <div>upsert : true · 보존 필드: vendor, model, serial, asset_tag, rack, ...</div>
        </div>
      </ConfirmDialog>

      <ConfirmDialog
        open={!!confirmDelete}
        title="서버스펙 삭제"
        description={`"${confirmDelete?.hostname}" 자산 정보를 삭제합니다. 이 작업은 되돌릴 수 없습니다.`}
        confirmLabel="삭제"
        danger
        onCancel={() => setConfirmDelete(null)}
        onConfirm={handleDelete}
      />

      <NodeSpecCsvUploadModal
        open={csvOpen}
        onClose={() => setCsvOpen(false)}
        onApplied={() => {
          qc.invalidateQueries({ queryKey: ['node-specs'] });
        }}
      />

      <NodeSpecPasteModal
        open={pasteOpen}
        onClose={() => { setPasteOpen(false); setPasteInitialText(''); }}
        onApplied={() => {
          qc.invalidateQueries({ queryKey: ['node-specs'] });
        }}
        displayColumns={NODE_SPEC_COLUMNS}
        initialText={pasteInitialText}
      />

      {hostFactsOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => !collectingFacts && closeHostFacts()} />
          <div ref={hostFactsRef} role="dialog" aria-modal="true" aria-label="Host Facts 수집" className="relative w-full max-w-2xl bg-card border border-border rounded-xl p-5 shadow-2xl max-h-[90vh] overflow-y-auto">
            <h3 className="text-base font-semibold mb-3">Host Facts 수집 (bond/disk/vm)</h3>
            <div className="grid grid-cols-2 gap-3">
              <input value={sshUser} onChange={(e) => setSshUser(e.target.value)} placeholder="SSH user (root)"
                className="px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
              <input type="password" value={sshPassword} onChange={(e) => setSshPassword(e.target.value)} placeholder="SSH password (선택)"
                className="px-3 py-2 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </div>
            <textarea value={sshPrivateKey} onChange={(e) => setSshPrivateKey(e.target.value)} placeholder="Private Key (선택, PEM)"
              className="mt-3 w-full h-24 px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            <div className="mt-3 border border-border rounded-lg p-2 bg-background/60">
              <p className="text-sm text-muted-foreground mb-2">노드 일괄 실행 기준 노드 선택 (자동 로딩)</p>
              {clusterNodeCandidates.length === 0 ? (
                <p className="text-sm text-muted-foreground">선택한 클러스터의 노드 정보가 없습니다.</p>
              ) : (
                <div className="max-h-28 overflow-auto grid grid-cols-2 gap-1.5">
                  {clusterNodeCandidates.map((h) => (
                    <label key={h} className="text-sm flex items-center gap-1.5">
                      <input
                        type="checkbox"
                        checked={selectedHosts.includes(h)}
                        onChange={(e) => setSelectedHosts((prev) => e.target.checked ? [...prev, h] : prev.filter((x) => x !== h))}
                      />
                      <span className="font-mono">{h}</span>
                    </label>
                  ))}
                </div>
              )}
            </div>
            <textarea value={hostList} onChange={(e) => setHostList(e.target.value)} placeholder={'호스트 목록 (공백/콤마/줄바꿈 구분)\n10.0.0.11\n10.0.0.12'}
              className="mt-3 w-full h-28 px-3 py-2 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            <label className="mt-2 flex items-center gap-2 text-sm">
              <input type="checkbox" checked={useSudo} onChange={(e) => setUseSudo(e.target.checked)} />
              sudo -n 사용
            </label>

            {/* 실행 결과 — 건수 요약 + 상세 로그(사용자가 켜고 끄는 "로그 보기"). CLAUDE.md:
                모든 "실행" 버튼은 상세 로그 출력 + 로그 보기 옵션을 함께 제공해야 한다. */}
            {hostFactsResult && (
              <div className="mt-4 border border-border rounded-lg overflow-hidden">
                <div className="flex items-center gap-2 px-3 py-2 bg-muted/30">
                  <span className={`text-sm ${hostFactsResult.errors.length > 0 ? 'text-status-warning' : 'text-status-healthy'}`}>
                    신규 {hostFactsResult.inserted} · 업데이트 {hostFactsResult.updated} · 스킵 {hostFactsResult.skipped}
                    {hostFactsResult.errors.length > 0 && ` · 오류 ${hostFactsResult.errors.length}`}
                  </span>
                  <button
                    onClick={() => setHostFactsLogOpen((v) => !v)}
                    className="ml-auto flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                    aria-expanded={hostFactsLogOpen}
                  >
                    <ScrollText className="w-3.5 h-3.5" />
                    {hostFactsLogOpen ? '로그 숨기기' : `로그 보기 (호스트 ${hostFactsResult.items.length}건)`}
                  </button>
                </div>
                {hostFactsLogOpen && (
                  <LogViewer text={buildHostFactsLog(hostFactsResult)} maxHeight="max-h-64" />
                )}
              </div>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <button onClick={closeHostFacts} disabled={collectingFacts} className="px-3 py-1.5 text-sm rounded-lg border border-border bg-secondary hover:bg-secondary/80">
                {hostFactsResult ? '닫기' : '취소'}
              </button>
              <button onClick={() => setConfirmHostFacts(true)} disabled={collectingFacts} className="px-3 py-1.5 text-sm rounded-lg bg-primary text-primary-foreground hover:bg-primary/90">
                {collectingFacts ? '수집 중...' : '수집 실행'}
              </button>
            </div>
          </div>
        </div>
      )}

      <ConfirmDialog
        open={confirmHostFacts}
        title="Host Facts 수집 실행"
        description={`${hostFactsHosts.length}개 호스트에 SSH(${sshUser || 'root'})로 접속해 bond/disk/vm 정보를 읽고 기존 서버스펙을 덮어씁니다. 실제 운영 호스트에 접속이 나갑니다.`}
        danger
        confirmLabel="실행"
        onConfirm={() => { setConfirmHostFacts(false); handleCollectHostFacts(); }}
        onCancel={() => setConfirmHostFacts(false)}
      />
    </div>
  );
}

export default NodeSpecPage;
