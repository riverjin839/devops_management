// DC 토폴로지 편집기 오른쪽 속성 패널 — 선택한 개체(장비·랙·구간·연결)를 그 자리에서 고치고 관계를 보여준다.
// 값은 입력을 벗어나거나(blur) 선택을 바꾸면 바로 저장된다. 아무것도 선택하지 않으면 사용법과 DC 목록.
import { useEffect, useRef, useState } from 'react';
import { Link2Off, Pencil, Plus } from 'lucide-react';
import { dcApi } from '@/services/api';
import type { DcDeviceRole, DcDeviceStatus, DcTopoEdge, DcTopoRack, DcTopoZone, DcTopology } from '@/types';
import type { EntityDraft } from './DcEntityDialog';
import { BTN, INPUT, ROLE_LABEL, ROLE_OPTIONS } from './shared';

export type Selection =
  | { kind: 'device'; id: string }
  | { kind: 'rack'; id: string }
  | { kind: 'zone'; id: string }
  | { kind: 'edge'; id: string };

export interface DeviceInfo {
  id: string;
  hostname: string;
  role: DcDeviceRole;
  status: DcDeviceStatus;
  rackId: string | null;
  positionU: number | null;
  clusterId: string | null;
}

const STATUSES: DcDeviceStatus[] = ['planned', 'active', 'spare', 'maintenance', 'decommission'];
const REL_LABEL: Record<string, [string, string]> = {
  contains: ['포함', '소속'], hosts: ['클러스터 운영', '운영 구간'],
  member_of: ['클러스터 소속', '구성 장비'], uplink_to: ['하위 연결', '상위 연결'],
};
const TYPE_LABEL: Record<string, string> = {
  site: 'DC', zone: '구간', rack: '랙', cluster: '클러스터', 'fa-core': 'FA 코어', 'super-spine': 'super-spine',
  spine: 'spine', leaf: 'leaf', server: '서버', mgmt: 'mgmt', patch: '패치패널',
};
const LABEL = 'block text-xs font-semibold text-muted-foreground mb-1';
const FIELD = `${INPUT} w-full`;

interface Props {
  topology: DcTopology;
  selection: Selection | null;
  device: DeviceInfo | null;
  rack: DcTopoRack | null;
  zone: DcTopoZone | null;
  edge: DcTopoEdge | null;
  clusters: { id: string; name: string }[];
  canOperate: boolean;
  hint: string | undefined;
  isAdmin: boolean;
  /** 값이 바뀔 때마다 이름 입력에 포커스를 준다(새로 만든 직후·더블클릭). */
  focusToken: number;
  act: (fn: () => Promise<unknown>, done: string, failed: string) => Promise<void>;
  onEdit: (draft: EntityDraft) => void;
  onDelete: () => void;
  onToggleRack: (id: string) => void;
  rackOpen: boolean;
}

export function DcTopologyInspector({
  topology, selection, device, rack, zone, edge, clusters, canOperate, hint, isAdmin, focusToken,
  act, onEdit, onDelete, onToggleRack, rackOpen,
}: Props) {
  const nameRef = useRef<HTMLInputElement | null>(null);
  const [form, setForm] = useState<Record<string, string>>({});
  const [addCluster, setAddCluster] = useState('');
  const key = selection ? `${selection.kind}:${selection.id}` : '';

  // 선택이 바뀌거나 서버 값이 바뀌면 폼을 다시 채운다.
  useEffect(() => {
    if (device) {
      setForm({
        name: device.hostname, role: device.role, status: device.status, rackId: device.rackId ?? '',
        positionU: device.positionU !== null ? String(device.positionU) : '', clusterId: device.clusterId ?? '',
      });
    } else if (rack) {
      setForm({ name: rack.name, rackNo: rack.rackNo !== null ? String(rack.rackNo) : '', uHeight: String(rack.uHeight) });
    } else if (zone) {
      setForm({ name: zone.name, zoneNo: zone.zoneNo !== null ? String(zone.zoneNo) : '', description: zone.description ?? '' });
    } else {
      setForm({});
    }
  }, [key, device, rack, zone]);

  useEffect(() => {
    if (focusToken > 0) { nameRef.current?.focus(); nameRef.current?.select(); }
  }, [focusToken, key]);

  const set = (k: string) => (e: { target: { value: string } }) => setForm((p) => ({ ...p, [k]: e.target.value }));
  const num = (v: string | undefined) => (v && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

  const saveDevice = (patch: Record<string, unknown>, what: string) => {
    if (!device) return;
    void act(() => dcApi.update('devices', device.id, patch), `${device.hostname} ${what} 변경`, '저장하지 못했습니다');
  };

  const names = new Map(topology.ontology.entities.map((e) => [e.id, e]));
  const relationId = selection && selection.kind !== 'edge' ? selection.id : null;
  const relations = relationId
    ? topology.ontology.relationships.filter((r) => r.source === relationId || r.target === relationId)
    : [];

  const title = device ? ROLE_LABEL[device.role] : rack ? '랙' : zone ? '구간' : edge ? '연결' : '';

  return (
    <aside aria-label="속성" className="w-full xl:w-72 shrink-0 rounded-md border border-border bg-card p-4 space-y-3 self-stretch">
      <p className="text-sm font-semibold">속성{title && <span className="font-normal text-muted-foreground"> · {title}</span>}</p>

      {!selection && (
        <>
          <ul className="text-sm text-muted-foreground space-y-1.5 list-disc pl-4">
            <li>왼쪽 도형을 캔버스로 끌어다 놓으면 바로 만들어집니다.</li>
            <li>장비를 누르면 나오는 파란 손잡이를 다른 장비로 끌면 연결됩니다.</li>
            <li>더블클릭으로 이름 고치기, Delete 로 삭제, 빈 곳을 끌어 화면 이동, 휠로 확대.</li>
          </ul>
          <div className="pt-3 border-t border-border space-y-1.5">
            <div className="flex items-center justify-between">
              <span className="text-xs font-semibold text-muted-foreground">DC</span>
              <button type="button" className={`${BTN} py-1 text-xs`} disabled={!canOperate} title={hint ?? 'DC 추가'}
                onClick={() => onEdit({ kind: 'site' })}>
                <Plus className="w-3.5 h-3.5" aria-hidden /> DC
              </button>
            </div>
            {topology.sites.length === 0 && <p className="text-xs text-muted-foreground">구간을 놓으면 DC 가 함께 만들어집니다.</p>}
            {topology.sites.map((s) => (
              <div key={s.id} className="flex items-center gap-2 text-sm">
                <span className="flex-1 truncate">{s.name}</span>
                <span className="text-xs text-muted-foreground">구간 {topology.zones.filter((z) => z.siteId === s.id).length}</span>
                <button type="button" disabled={!canOperate} title={hint ?? `${s.name} 수정`} aria-label={`${s.name} 수정`}
                  className="inline-flex items-center justify-center w-7 h-7 rounded-xl text-muted-foreground hover:bg-secondary disabled:opacity-40"
                  onClick={() => onEdit({ kind: 'site', id: s.id, name: s.name, description: s.description })}>
                  <Pencil className="w-3.5 h-3.5" aria-hidden />
                </button>
              </div>
            ))}
          </div>
        </>
      )}

      {device && (
        <>
          <div>
            <label className={LABEL} htmlFor="ti-name">이름</label>
            <input id="ti-name" ref={nameRef} className={FIELD} value={form.name ?? ''} disabled={!canOperate} onChange={set('name')}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              onBlur={() => { if (form.name && form.name.trim() !== device.hostname) saveDevice({ hostname: form.name.trim() }, '이름'); }} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="ti-role">역할</label>
              <select id="ti-role" className={FIELD} value={form.role ?? device.role} disabled={!canOperate}
                onChange={(e) => { set('role')(e); saveDevice({ role: e.target.value }, '역할'); }}>
                {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="ti-status">상태</label>
              <select id="ti-status" className={FIELD} value={form.status ?? device.status} disabled={!canOperate}
                onChange={(e) => { set('status')(e); saveDevice({ status: e.target.value }, '상태'); }}>
                {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="ti-rack">랙</label>
              <select id="ti-rack" className={FIELD} value={form.rackId ?? ''} disabled={!canOperate}
                onChange={(e) => { set('rackId')(e); saveDevice({ rackId: e.target.value || null, positionU: null }, '랙'); }}>
                <option value="">랙 없음</option>
                {topology.racks.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
              </select>
            </div>
            <div>
              <label className={LABEL} htmlFor="ti-u">시작 U</label>
              <input id="ti-u" type="number" min={1} max={60} className={FIELD} value={form.positionU ?? ''}
                disabled={!canOperate || !device.rackId} onChange={set('positionU')}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                onBlur={() => { if (num(form.positionU) !== device.positionU) saveDevice({ positionU: num(form.positionU) }, '위치'); }} />
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="ti-cluster">K8s 클러스터</label>
            <select id="ti-cluster" className={FIELD} value={form.clusterId ?? ''} disabled={!canOperate}
              onChange={(e) => { set('clusterId')(e); saveDevice({ clusterId: e.target.value || null }, '클러스터'); }}>
              <option value="">없음</option>
              {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </div>
        </>
      )}

      {rack && (
        <>
          <div>
            <label className={LABEL} htmlFor="ti-name">이름</label>
            <input id="ti-name" ref={nameRef} className={FIELD} value={form.name ?? ''} disabled={!canOperate} onChange={set('name')}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
              onBlur={() => {
                if (form.name && form.name.trim() !== rack.name) {
                  void act(() => dcApi.update('racks', rack.id, { name: form.name.trim() }), '랙 이름 변경', '저장하지 못했습니다');
                }
              }} />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={LABEL} htmlFor="ti-rno">랙 번호</label>
              <input id="ti-rno" type="number" min={0} className={FIELD} value={form.rackNo ?? ''} disabled={!canOperate} onChange={set('rackNo')}
                onBlur={() => {
                  if (num(form.rackNo) !== rack.rackNo) {
                    void act(() => dcApi.update('racks', rack.id, { rackNo: num(form.rackNo) }), '랙 번호 변경', '저장하지 못했습니다');
                  }
                }} />
            </div>
            <div>
              <label className={LABEL} htmlFor="ti-uh">높이 (U)</label>
              <input id="ti-uh" type="number" min={1} max={60} className={FIELD} value={form.uHeight ?? ''} disabled={!canOperate} onChange={set('uHeight')}
                onBlur={() => {
                  const v = num(form.uHeight);
                  if (v !== null && v !== rack.uHeight) {
                    void act(() => dcApi.update('racks', rack.id, { uHeight: v }), '랙 높이 변경', '저장하지 못했습니다');
                  }
                }} />
            </div>
          </div>
          <p className="text-sm text-muted-foreground">
            장비 {rack.devices.length}대 · {rack.usedU}/{rack.uHeight}U 사용
          </p>
          <button type="button" className={`${BTN} w-full justify-center`} onClick={() => onToggleRack(rack.id)}>
            {rackOpen ? '접기' : '펼쳐서 ToR · 서버 보기'}
          </button>
        </>
      )}

      {zone && (
        <>
          <div className="grid grid-cols-3 gap-2">
            <div>
              <label className={LABEL} htmlFor="ti-zno">번호</label>
              <input id="ti-zno" type="number" min={0} className={FIELD} value={form.zoneNo ?? ''} disabled={!canOperate} onChange={set('zoneNo')}
                onBlur={() => {
                  if (num(form.zoneNo) !== zone.zoneNo) {
                    void act(() => dcApi.update('halls', zone.id, { zoneNo: num(form.zoneNo) }), '구간 번호 변경', '저장하지 못했습니다');
                  }
                }} />
            </div>
            <div className="col-span-2">
              <label className={LABEL} htmlFor="ti-name">구간 이름</label>
              <input id="ti-name" ref={nameRef} className={FIELD} value={form.name ?? ''} disabled={!canOperate} onChange={set('name')}
                onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }}
                onBlur={() => {
                  if (form.name && form.name.trim() !== zone.name) {
                    void act(() => dcApi.update('halls', zone.id, { name: form.name.trim() }), '구간 이름 변경', '저장하지 못했습니다');
                  }
                }} />
            </div>
          </div>
          <div>
            <label className={LABEL} htmlFor="ti-desc">구획 설명</label>
            <input id="ti-desc" className={FIELD} value={form.description ?? ''} disabled={!canOperate} onChange={set('description')}
              placeholder="위치·용도·전력 구획 등"
              onBlur={() => {
                if ((form.description ?? '') !== (zone.description ?? '')) {
                  void act(() => dcApi.update('halls', zone.id, { description: form.description || null }), '구간 설명 변경', '저장하지 못했습니다');
                }
              }} />
          </div>
          <div>
            <span className={LABEL}>연결된 K8s 클러스터</span>
            <div className="flex flex-wrap gap-1.5">
              {zone.clusters.length === 0 && <span className="text-sm text-muted-foreground">없음</span>}
              {zone.clusters.map((c) => (
                <span key={c.linkId} className="inline-flex items-center gap-1 pl-2 pr-1 py-0.5 rounded-full border border-border bg-background text-xs">
                  {c.name}
                  <button type="button" disabled={!canOperate} title={hint ?? `${c.name} 연결 해제`} aria-label={`${c.name} 연결 해제`}
                    className="inline-flex items-center justify-center w-5 h-5 rounded-full hover:bg-secondary disabled:opacity-40"
                    onClick={() => void act(() => dcApi.remove('zone-clusters', c.linkId), `${c.name} 연결 해제`, '해제하지 못했습니다')}>
                    <Link2Off className="w-3 h-3" aria-hidden />
                  </button>
                </span>
              ))}
            </div>
            <div className="mt-2 flex gap-1.5">
              <label className="sr-only" htmlFor="ti-zc">연결할 클러스터</label>
              <select id="ti-zc" className={`${INPUT} flex-1 min-w-0`} value={addCluster} disabled={!canOperate}
                onChange={(e) => setAddCluster(e.target.value)}>
                <option value="">클러스터 연결…</option>
                {clusters.filter((c) => !zone.clusters.some((z) => z.clusterId === c.id)).map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </select>
              <button type="button" className={BTN} disabled={!canOperate || !addCluster}
                onClick={() => {
                  const clusterId = addCluster;
                  setAddCluster('');
                  void act(() => dcApi.create('zone-clusters', { hallId: zone.id, clusterId }), '클러스터를 연결했습니다', '연결하지 못했습니다');
                }}>
                연결
              </button>
            </div>
          </div>
        </>
      )}

      {edge && (
        <div className="text-sm space-y-1.5">
          <p>{names.get(edge.upperId)?.name} → {names.get(edge.lowerId)?.name}</p>
          <p className="text-muted-foreground">
            {edge.cableCount > 0 ? `등록된 케이블 ${edge.cableCount}개` : '화면에서 그은 연결 — 케이블은 아직 등록되지 않았습니다'}
            {edge.linkId && edge.cableCount > 0 ? ' + 논리 연결' : ''}
          </p>
          {!edge.linkId && <p className="text-xs text-muted-foreground">케이블에서 파생된 선이라 케이블을 지워야 사라집니다.</p>}
        </div>
      )}

      {relationId && (
        <div className="pt-3 border-t border-border">
          <p className="text-xs font-semibold text-muted-foreground mb-1.5">관계</p>
          {relations.length === 0 ? (
            <p className="text-sm text-muted-foreground">아직 관계가 없습니다.</p>
          ) : (
            <ul className="space-y-1 text-sm max-h-48 overflow-y-auto">
              {relations.slice(0, 40).map((r) => {
                const outgoing = r.source === relationId;
                const other = names.get(outgoing ? r.target : r.source);
                const [out, inc] = REL_LABEL[r.type] ?? [r.type, r.type];
                return (
                  <li key={`${r.source}-${r.type}-${r.target}`} className="flex items-baseline gap-2">
                    <span className="text-xs text-muted-foreground w-20 shrink-0">{outgoing ? out : inc}</span>
                    <span className="truncate">
                      {other?.name ?? '?'} <span className="text-xs text-muted-foreground">{TYPE_LABEL[other?.type ?? ''] ?? other?.type}</span>
                    </span>
                  </li>
                );
              })}
              {relations.length > 40 && <li className="text-xs text-muted-foreground">+{relations.length - 40}개 더</li>}
            </ul>
          )}
        </div>
      )}

      {selection && (
        <div className="pt-3 border-t border-border flex gap-2">
          {(device || rack || zone) && (
            <button type="button" className={`${BTN} flex-1 justify-center`} disabled={!canOperate} title={hint ?? '모든 항목을 폼으로 수정'}
              onClick={() => {
                if (device) {
                  onEdit({ kind: 'device', id: device.id, hostname: device.hostname, role: device.role, status: device.status,
                    rackId: device.rackId, positionU: device.positionU, clusterId: device.clusterId });
                } else if (rack) {
                  onEdit({ kind: 'rack', id: rack.id, zoneId: rack.zoneId ?? undefined, rowName: rack.rowName ?? 'A', name: rack.name,
                    rackNo: rack.rackNo, uHeight: rack.uHeight });
                } else if (zone) {
                  onEdit({ kind: 'zone', id: zone.id, siteId: zone.siteId, name: zone.name, zoneNo: zone.zoneNo, description: zone.description });
                }
              }}>
              자세히
            </button>
          )}
          {(() => {
            const adminOnly = Boolean(device) && !isAdmin;
            const blocked = !canOperate || adminOnly || (edge !== null && !edge.linkId);
            const why = !canOperate ? hint : adminOnly ? '장비 삭제는 admin 만 — 상태를 decommission 으로 바꾸세요' : undefined;
            return (
              <button type="button" className={`${BTN} text-status-critical border-status-critical/40`} disabled={blocked} title={why ?? '삭제 (Delete)'}
                onClick={onDelete}>
                삭제
              </button>
            );
          })()}
        </div>
      )}
    </aside>
  );
}
