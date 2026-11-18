// 노드 그룹 추가·편집 — 이름 · 노드 패턴(glob, 쉼표) · 설명. 입력하면 수집된 노드 중 일치하는 노드를 바로 보여준다.
// 노드는 위쪽(먼저 만든) 그룹부터 처음 일치한 그룹 하나에만 속하고, 어느 그룹에도 없으면 기본 그룹이다.
import { useEffect, useMemo, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import type { ServiceConfigGroupInfo } from '@/types';
import { matchNodes } from './matchNodes';

const INPUT = 'w-full px-2.5 py-1.5 rounded-xl border border-border bg-card text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary';

interface Props {
  open: boolean;
  group: ServiceConfigGroupInfo | null;
  allNodes: string[];
  busy: boolean;
  onClose: () => void;
  onSave: (body: { name: string; nodePattern: string; description: string | null }) => void;
}

export function GroupDialog({ open, group, allNodes, busy, onClose, onSave }: Props) {
  const [name, setName] = useState('');
  const [pattern, setPattern] = useState('');
  const [desc, setDesc] = useState('');
  useEffect(() => {
    if (!open) return;
    setName(group?.name ?? '');
    setPattern(group?.nodePattern ?? '');
    setDesc(group?.description ?? '');
  }, [open, group]);
  const matched = useMemo(() => matchNodes(pattern, allNodes), [pattern, allNodes]);
  const invalid = !name.trim() || name.trim() === '기본' || !pattern.trim();

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !busy) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>{group ? '노드 그룹 편집' : '노드 그룹 추가'}</DialogTitle>
          <DialogDescription>그룹 노드에만 다른 값을 줄 때 쓴다. 그룹 화면에서 비운 값은 기본 그룹 값을 그대로 따른다.</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 px-5 pb-3">
          <label className="block text-xs">
            <span className="text-muted-foreground">이름</span>
            <input className={`${INPUT} mt-1`} value={name} onChange={(e) => setName(e.target.value)} placeholder="GPU 노드" aria-label="그룹 이름" />
          </label>
          <label className="block text-xs">
            <span className="text-muted-foreground">노드 패턴</span>
            <input className={`${INPUT} mt-1 font-mono`} value={pattern} onChange={(e) => setPattern(e.target.value)} placeholder="gpu-*, infer-?" aria-label="노드 패턴" />
            <span className="block mt-1 text-muted-foreground">노드 이름(SSH 로 수집한 서비스는 접속 주소)에 맞추는 glob, 쉼표로 여러 개.</span>
          </label>
          <div className="text-xs">
            <span className="text-muted-foreground">일치하는 노드 {matched.length}/{allNodes.length}</span>
            <p className="mt-1 font-mono break-all text-foreground">{matched.length ? matched.join(', ') : '—'}</p>
          </div>
          <label className="block text-xs">
            <span className="text-muted-foreground">설명 (선택)</span>
            <textarea className={`${INPUT} mt-1 min-h-[56px]`} value={desc} onChange={(e) => setDesc(e.target.value)} aria-label="그룹 설명" />
          </label>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>취소</Button>
          <Button onClick={() => onSave({ name: name.trim(), nodePattern: pattern.trim(), description: desc.trim() || null })}
            disabled={invalid || busy}>{busy ? '저장 중…' : '저장'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
