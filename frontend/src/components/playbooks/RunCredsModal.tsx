import { useEffect, useState } from 'react';
import { KeyRound, X, Play } from 'lucide-react';
import type { PlaybookSshCreds } from '@/types';

const SESSION_KEY = 'k8s:playbook-ssh-creds';

interface RunCredsModalProps {
  open: boolean;
  playbookName: string;
  onClose: () => void;
  onRun: (creds: PlaybookSshCreds) => void;
}

/** Playbook 실행 직전 SSH 자격증명을 받는 모달.
 *
 * - 자격증명은 sessionStorage 에 저장돼 같은 탭/세션 동안 자동으로 채워짐.
 * - 서버에는 휘발성으로 전달되며 DB 에 보관되지 않음.
 * - 노드에 이미 매니지드 inventory(ansible_user/pass 포함) 가 설정돼 있다면
 *   비워두고 실행해도 무방하다.
 */
export function RunCredsModal({ open, playbookName, onClose, onRun }: RunCredsModalProps) {
  const [username, setUsername] = useState('root');
  const [password, setPassword] = useState('');
  const [privateKey, setPrivateKey] = useState('');
  const [port, setPort] = useState<number | ''>(22);
  const [become, setBecome] = useState(true);
  const [becomePass, setBecomePass] = useState('');
  const [authMode, setAuthMode] = useState<'password' | 'key'>('password');
  const [remember, setRemember] = useState(true);

  // 세션에 저장된 값 자동 복원
  useEffect(() => {
    if (!open) return;
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) {
        const c = JSON.parse(raw) as PlaybookSshCreds & { authMode?: 'password' | 'key' };
        if (c.ssh_username) setUsername(c.ssh_username);
        if (c.ssh_password) setPassword(c.ssh_password);
        if (c.ssh_private_key) setPrivateKey(c.ssh_private_key);
        if (c.ssh_port) setPort(c.ssh_port);
        if (c.become !== undefined) setBecome(!!c.become);
        if (c.become_password) setBecomePass(c.become_password);
        if (c.authMode) setAuthMode(c.authMode);
      }
    } catch { /* ignore */ }
  }, [open]);

  if (!open) return null;

  const handleSubmit = () => {
    const creds: PlaybookSshCreds = {
      ssh_username: username.trim() || undefined,
      ssh_port: typeof port === 'number' ? port : undefined,
      become,
    };
    if (authMode === 'password' && password) creds.ssh_password = password;
    if (authMode === 'key' && privateKey.trim()) creds.ssh_private_key = privateKey.trim();
    if (become && becomePass) creds.become_password = becomePass;

    if (remember) {
      try {
        sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...creds, authMode }));
      } catch { /* ignore */ }
    }

    onRun(creds);
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
      <div className="bg-card border border-border rounded-2xl w-full max-w-md mac-shadow">
        <div className="flex items-center justify-between px-5 py-3 border-b border-border">
          <div className="flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-primary" />
            <h2 className="font-semibold text-sm">SSH 자격증명</h2>
          </div>
          <button onClick={onClose} className="p-1 rounded hover:bg-secondary text-muted-foreground hover:text-foreground">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 py-4 space-y-3">
          <p className="text-sm text-muted-foreground">
            <span className="font-medium text-foreground">{playbookName}</span> 을 노드에서 실행합니다.
            인증 정보는 서버에 저장되지 않으며 (선택 시) 브라우저 세션 동안만 캐싱됩니다.
          </p>

          <div className="grid grid-cols-3 gap-2">
            <label className="col-span-2 text-sm">
              <span className="block text-muted-foreground mb-1">사용자명</span>
              <input value={username} onChange={(e) => setUsername(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="root" />
            </label>
            <label className="text-sm">
              <span className="block text-muted-foreground mb-1">포트</span>
              <input type="number" value={port}
                onChange={(e) => setPort(e.target.value ? parseInt(e.target.value, 10) : '')}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary" />
            </label>
          </div>

          <div className="flex items-center gap-1 text-sm">
            <button type="button" onClick={() => setAuthMode('password')}
              className={`px-3 py-1 rounded-lg border ${authMode === 'password' ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground'}`}>
              비밀번호
            </button>
            <button type="button" onClick={() => setAuthMode('key')}
              className={`px-3 py-1 rounded-lg border ${authMode === 'key' ? 'bg-primary/10 text-primary border-primary/40' : 'bg-secondary border-border text-muted-foreground'}`}>
              개인키
            </button>
          </div>

          {authMode === 'password' ? (
            <label className="block text-sm">
              <span className="block text-muted-foreground mb-1">비밀번호</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)}
                className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                placeholder="••••••••" />
            </label>
          ) : (
            <label className="block text-sm">
              <span className="block text-muted-foreground mb-1">SSH 개인키 (PEM)</span>
              <textarea value={privateKey} onChange={(e) => setPrivateKey(e.target.value)} rows={4}
                className="w-full px-2 py-1.5 text-sm font-mono bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary resize-y"
                placeholder="-----BEGIN OPENSSH PRIVATE KEY-----&#10;...&#10;-----END OPENSSH PRIVATE KEY-----" />
            </label>
          )}

          <div className="border-t border-border pt-3 space-y-2">
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={become} onChange={(e) => setBecome(e.target.checked)} />
              <span>sudo (become) 사용</span>
            </label>
            {become && (
              <label className="block text-sm">
                <span className="block text-muted-foreground mb-1">become 비밀번호 (필요 시)</span>
                <input type="password" value={becomePass} onChange={(e) => setBecomePass(e.target.value)}
                  className="w-full px-2 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-1 focus:ring-primary"
                  placeholder="(NOPASSWD 면 비워둠)" />
              </label>
            )}
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
              <span>이 세션 동안 기억하기 (브라우저 sessionStorage)</span>
            </label>
          </div>
        </div>

        <div className="flex justify-end gap-2 px-5 py-3 border-t border-border bg-muted/10">
          <button onClick={onClose}
            className="px-4 py-1.5 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg">
            취소
          </button>
          <button onClick={handleSubmit}
            className="px-4 py-1.5 text-sm font-semibold bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg flex items-center gap-1.5">
            <Play className="w-3.5 h-3.5" /> 실행
          </button>
        </div>
      </div>
    </div>
  );
}
