import { useState } from 'react';
import type { ScriptKind } from '@/types';
import { useCreateScript } from '@/hooks/useScripts';
import { useToast } from '@/components/common';
import { formatApiError } from '@/lib/utils';

const KIND_OPTIONS: { value: ScriptKind; label: string; placeholder: string }[] = [
  { value: 'shell', label: 'Shell', placeholder: '#!/usr/bin/env bash\necho hello' },
  { value: 'ansible_playbook', label: 'Ansible Playbook', placeholder: '- hosts: all\n  tasks:\n    - name: ping\n      ping:' },
  { value: 'python', label: 'Python', placeholder: 'print("hello")' },
];

interface Props {
  onCreated: (scriptId: string) => void;
  onCancel: () => void;
}

export function ScriptCreateForm({ onCreated, onCancel }: Props) {
  const toast = useToast();
  const createMut = useCreateScript();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<ScriptKind>('shell');
  const [description, setDescription] = useState('');
  const [tags, setTags] = useState('');
  const [content, setContent] = useState('');

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast.error('이름을 입력해주세요.');
      return;
    }
    if (!content.trim()) {
      toast.error('스크립트 내용을 입력해주세요.');
      return;
    }
    try {
      const script = await createMut.mutateAsync({
        name: name.trim(),
        kind,
        description: description.trim() || undefined,
        tags: tags.split(',').map((t) => t.trim()).filter(Boolean),
        content,
        changelog: '최초 생성',
      });
      toast.success(`"${script.name}" 스크립트를 만들었습니다.`);
      onCreated(script.id);
    } catch (e) {
      toast.error('생성 실패', formatApiError(e));
    }
  };

  return (
    <div className="p-4 space-y-3 max-w-2xl">
      <h2 className="text-sm font-semibold">새 스크립트</h2>
      <div className="grid grid-cols-2 gap-3">
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">이름</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
            placeholder="예: etcd 압축(defrag)"
          />
        </label>
        <label className="text-xs space-y-1">
          <span className="text-muted-foreground">실행 방식</span>
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value as ScriptKind)}
            className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
          >
            {KIND_OPTIONS.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </label>
      </div>
      <label className="text-xs space-y-1 block">
        <span className="text-muted-foreground">설명 (선택)</span>
        <input
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="text-xs space-y-1 block">
        <span className="text-muted-foreground">태그 (콤마로 구분, 선택)</span>
        <input
          value={tags}
          onChange={(e) => setTags(e.target.value)}
          placeholder="etcd, cleanup"
          className="w-full px-2.5 py-1.5 text-xs rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring"
        />
      </label>
      <label className="text-xs space-y-1 block">
        <span className="text-muted-foreground">스크립트 내용</span>
        <textarea
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={KIND_OPTIONS.find((o) => o.value === kind)?.placeholder}
          rows={14}
          spellCheck={false}
          className="w-full px-2.5 py-2 text-xs font-mono rounded-xl border border-border bg-card focus:outline-none focus:ring-2 focus:ring-ring resize-y"
        />
      </label>
      <div className="flex items-center gap-2 pt-1">
        <button
          onClick={handleSubmit}
          disabled={createMut.isPending}
          className="px-3 py-1.5 text-xs font-medium bg-primary text-primary-foreground rounded-xl hover:bg-primary/90 disabled:opacity-50"
        >
          {createMut.isPending ? '생성 중…' : '생성'}
        </button>
        <button
          onClick={onCancel}
          className="px-3 py-1.5 text-xs font-medium border border-border rounded-xl hover:bg-secondary"
        >
          취소
        </button>
      </div>
    </div>
  );
}
