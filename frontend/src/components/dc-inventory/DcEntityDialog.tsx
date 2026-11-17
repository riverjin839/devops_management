// DC 토폴로지의 추가·수정 폼 — DC(사이트) · 구간 · 랙 · 장비를 한 다이얼로그로 다룬다.
// 저장은 공통 CRUD(`dcApi.create/update`)로 가고, 제약 위반(U 겹침·이름 중복 등)은 서버 사유를 그대로 보여준다.
import { useEffect, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { formatApiError } from '@/lib/utils';
import { dcApi } from '@/services/api';
import type { DcDeviceRole, DcTopology } from '@/types';
import { BTN, BTN_PRIMARY, INPUT, ROLE_LABEL, ROLE_OPTIONS } from './shared';
import { ensureRackRow } from './topology/actions';

export type EntityDraft =
  | { kind: 'site'; id?: string; name?: string; description?: string | null }
  | { kind: 'zone'; id?: string; siteId?: string; name?: string; zoneNo?: number | null; description?: string | null }
  | { kind: 'rack'; id?: string; zoneId?: string; rowName?: string; name?: string; rackNo?: number | null; uHeight?: number }
  | {
      kind: 'device'; id?: string; hostname?: string; role?: DcDeviceRole; rackId?: string | null;
      positionU?: number | null; status?: string; clusterId?: string | null;
    };

const TITLE: Record<EntityDraft['kind'], string> = { site: 'DC', zone: '구간', rack: '랙', device: '장비' };
const STATUSES = ['planned', 'active', 'spare', 'maintenance', 'decommission'];

const LABEL = 'block text-xs font-semibold mb-1';
const FIELD = `${INPUT} w-full`;

function num(v: string): number | null {
  if (v.trim() === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

interface Props {
  draft: EntityDraft | null;
  topology: DcTopology;
  clusters: { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}

export function DcEntityDialog({ draft, topology, clusters, onClose, onSaved }: Props) {
  const [form, setForm] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!draft) return;
    setError(null);
    const d = draft as Record<string, unknown>;
    const init: Record<string, string> = {};
    for (const [k, v] of Object.entries(d)) {
      if (k !== 'kind' && k !== 'id' && v !== null && v !== undefined) init[k] = String(v);
    }
    if (draft.kind === 'zone' && !init.siteId) init.siteId = topology.sites[0]?.id ?? '';
    if (draft.kind === 'rack') {
      if (!init.zoneId) init.zoneId = topology.zones[0]?.id ?? '';
      if (!init.rowName) init.rowName = 'A';
      if (!init.uHeight) init.uHeight = '42';
    }
    if (draft.kind === 'device') {
      if (!init.role) init.role = 'server';
      if (!init.status) init.status = 'active';
    }
    setForm(init);
  }, [draft, topology.sites, topology.zones]);

  if (!draft) return null;
  const editing = Boolean(draft.id);
  const set = (k: string) => (e: { target: { value: string } }) => setForm((p) => ({ ...p, [k]: e.target.value }));

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (draft.kind === 'site') {
        const body = { name: form.name ?? '', description: form.description || null };
        await (editing ? dcApi.update('sites', draft.id!, body) : dcApi.create('sites', body));
      } else if (draft.kind === 'zone') {
        const body = {
          siteId: form.siteId, name: form.name ?? '', zoneNo: num(form.zoneNo ?? ''), description: form.description || null,
        };
        await (editing ? dcApi.update('halls', draft.id!, body) : dcApi.create('halls', body));
      } else if (draft.kind === 'rack') {
        if (!form.zoneId) throw new Error('구간을 먼저 만드세요.');
        const rowId = await ensureRackRow(form.zoneId, (form.rowName ?? 'A').trim() || 'A');
        const body = { rowId, name: form.name ?? '', rackNo: num(form.rackNo ?? ''), uHeight: num(form.uHeight ?? '') ?? 42 };
        await (editing ? dcApi.update('racks', draft.id!, body) : dcApi.create('racks', body));
      } else {
        const rackId = form.rackId || null;
        const body = {
          hostname: form.hostname ?? '', role: form.role, status: form.status, rackId,
          positionU: rackId ? num(form.positionU ?? '') : null, clusterId: form.clusterId || null,
        };
        await (editing ? dcApi.update('devices', draft.id!, body) : dcApi.create('devices', body));
      }
      onSaved();
      onClose();
    } catch (e) {
      setError(e instanceof Error && !('response' in e) ? e.message : formatApiError(e, '저장하지 못했습니다'));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{TITLE[draft.kind]} {editing ? '수정' : '추가'}</DialogTitle>
          <DialogDescription>
            {draft.kind === 'device'
              ? '여기서 등록한 장비는 노드 서버스펙·인프라 토폴로지에서도 같은 값으로 보입니다.'
              : '저장하면 변경 이력에 기록됩니다.'}
          </DialogDescription>
        </DialogHeader>
        <form className="grid grid-cols-2 gap-3" onSubmit={(e) => { e.preventDefault(); void save(); }}>
          {draft.kind === 'site' && (
            <>
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-f-name">DC 이름</label>
                <input id="dc-f-name" className={FIELD} value={form.name ?? ''} onChange={set('name')} placeholder="예: DC1" required />
              </div>
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-f-desc">설명</label>
                <input id="dc-f-desc" className={FIELD} value={form.description ?? ''} onChange={set('description')} />
              </div>
            </>
          )}
          {draft.kind === 'zone' && (
            <>
              <div>
                <label className={LABEL} htmlFor="dc-f-site">DC</label>
                <select id="dc-f-site" className={FIELD} value={form.siteId ?? ''} onChange={set('siteId')} required>
                  {topology.sites.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-zno">구간 번호</label>
                <input id="dc-f-zno" type="number" min={0} className={FIELD} value={form.zoneNo ?? ''} onChange={set('zoneNo')} placeholder="예: 1" />
              </div>
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-f-name">구간 이름</label>
                <input id="dc-f-name" className={FIELD} value={form.name ?? ''} onChange={set('name')} placeholder="예: A 구간 (1층 동쪽)" required />
              </div>
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-f-desc">구획 설명</label>
                <input id="dc-f-desc" className={FIELD} value={form.description ?? ''} onChange={set('description')} placeholder="위치·용도·전력 구획 등" />
              </div>
            </>
          )}
          {draft.kind === 'rack' && (
            <>
              <div>
                <label className={LABEL} htmlFor="dc-f-zone">구간</label>
                <select id="dc-f-zone" className={FIELD} value={form.zoneId ?? ''} onChange={set('zoneId')} required>
                  {topology.zones.map((z) => <option key={z.id} value={z.id}>{z.zoneNo !== null ? `#${z.zoneNo} ` : ''}{z.name}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-row">열</label>
                <input id="dc-f-row" className={FIELD} value={form.rowName ?? ''} onChange={set('rowName')} placeholder="예: A" required />
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-name">랙 이름</label>
                <input id="dc-f-name" className={FIELD} value={form.name ?? ''} onChange={set('name')} placeholder="예: R07" required />
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-rno">랙 번호</label>
                <input id="dc-f-rno" type="number" min={0} className={FIELD} value={form.rackNo ?? ''} onChange={set('rackNo')} placeholder="서브넷·ASN 규칙에 쓰임" />
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-uh">높이 (U)</label>
                <input id="dc-f-uh" type="number" min={1} max={60} className={FIELD} value={form.uHeight ?? ''} onChange={set('uHeight')} />
              </div>
            </>
          )}
          {draft.kind === 'device' && (
            <>
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-f-host">호스트명</label>
                <input id="dc-f-host" className={FIELD} value={form.hostname ?? ''} onChange={set('hostname')} placeholder="예: leaf-r07-a" required />
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-role">역할</label>
                <select id="dc-f-role" className={FIELD} value={form.role ?? 'server'} onChange={set('role')}>
                  {ROLE_OPTIONS.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-status">상태</label>
                <select id="dc-f-status" className={FIELD} value={form.status ?? 'active'} onChange={set('status')}>
                  {STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-rack">랙</label>
                <select id="dc-f-rack" className={FIELD} value={form.rackId ?? ''} onChange={set('rackId')}>
                  <option value="">랙 없음 (미배정)</option>
                  {topology.racks.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
                </select>
              </div>
              <div>
                <label className={LABEL} htmlFor="dc-f-u">시작 U (가장 아래)</label>
                <input id="dc-f-u" type="number" min={1} max={60} className={FIELD} value={form.positionU ?? ''}
                  onChange={set('positionU')} disabled={!form.rackId} placeholder={form.rackId ? '비우면 위치 미정' : '랙을 먼저 고르세요'} />
              </div>
              <div className="col-span-2">
                <label className={LABEL} htmlFor="dc-f-cluster">K8s 클러스터 (선택)</label>
                <select id="dc-f-cluster" className={FIELD} value={form.clusterId ?? ''} onChange={set('clusterId')}>
                  <option value="">없음</option>
                  {clusters.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="col-span-2 text-sm text-status-critical rounded-md border border-status-critical/30 bg-status-critical/5 px-3 py-2">
              {error}
            </p>
          )}
          <DialogFooter className="col-span-2">
            <button type="button" className={BTN} onClick={onClose} disabled={saving}>취소</button>
            <button type="submit" className={BTN_PRIMARY} disabled={saving}>{saving ? '저장 중' : '저장'}</button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
