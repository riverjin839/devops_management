import { useMemo } from 'react';
import { getAuthToken } from '@/stores/authStore';
import { k8sStreamUrls } from '@/services/api';
import { SshTerminalWindow } from './SshTerminalWindow';

export interface K9sConnectParams {
  host: string;
  port: number;
  username: string;
  authMode: 'password' | 'key';
  password: string;
  privateKey: string;
  namespace?: string;
  readonly?: boolean;
}

interface K9sTerminalProps {
  clusterId: string;
  params: K9sConnectParams;
  onClose: () => void;
  /** 주어지면 헤더에 "새 창으로 빼기" 버튼 노출 (별도 브라우저 창으로 세션 이동). */
  onPopOut?: () => void;
  /** 뷰포트 전체를 채운다 (팝업 창 전용). true 면 pop-out/전체화면 버튼은 숨긴다. */
  fill?: boolean;
}

const CLOSE_NOTES: Record<number, string> = {
  4403: '[k9s SSH 기능이 비활성화되어 있습니다]',
  4404: '[클러스터를 찾을 수 없습니다]',
};

/**
 * k9s TUI 웹 터미널 — control-plane 서버에 SSH 로 접속해 서버 내장 `k9s` 를
 * 스트리밍한다. xterm ↔ WebSocket 브리지와 창 크롬은 공용 `SshTerminalWindow` 가
 * 담당하고, 여기서는 k9s 전용 init 프레임(namespace/readonly)만 구성한다.
 * 백엔드가 paramiko PTY(invoke_shell) 로 브리지하며, tty + resize 를 지원하므로
 * k9s 풀스크린 UI 가 그대로 동작한다.
 */
export function K9sTerminal({ clusterId, params, onClose, onPopOut, fill }: K9sTerminalProps) {
  const url = useMemo(() => k8sStreamUrls.k9s(clusterId, getAuthToken()), [clusterId]);
  const init = {
    host: params.host,
    port: params.port,
    username: params.username,
    password: params.authMode === 'password' ? params.password : undefined,
    privateKey: params.authMode === 'key' ? params.privateKey : undefined,
    namespace: params.namespace || undefined,
    readonly: !!params.readonly,
  };
  const subtitle = `${params.username}@${params.host}:${params.port}`
    + (params.namespace ? ` · ns=${params.namespace}` : '')
    + (params.readonly ? ' · readonly' : '');

  return (
    <SshTerminalWindow
      label="k9s"
      subtitle={subtitle}
      url={url}
      init={init}
      closeNotes={CLOSE_NOTES}
      onClose={onClose}
      onPopOut={onPopOut}
      fill={fill}
    />
  );
}
