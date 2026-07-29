import { useMemo } from 'react';
import { getAuthToken } from '@/stores/authStore';
import { k8sStreamUrls } from '@/services/api';
import { SshTerminalWindow } from './SshTerminalWindow';

export interface NodeSshConnectParams {
  /** 표시용 노드 이름 (감사 로그에도 함께 남는다). 수동 host 입력이면 비어 있다. */
  nodeName?: string;
  host: string;
  port: number;
  username: string;
  authMode: 'password' | 'key';
  password: string;
  privateKey: string;
  /** 접속 직후 셸에 한 줄로 입력할 명령 (예: `sudo -i`, `cd /var/log`). 선택. */
  initialCommand?: string;
  /** 감사 로그 맥락용 — 클러스터 밖 서버에 붙을 수도 있어 선택값이다. */
  clusterId?: string;
}

interface NodeSshTerminalProps {
  params: NodeSshConnectParams;
  onClose: () => void;
  /** 주어지면 헤더에 "새 창으로 빼기" 버튼 노출 (별도 브라우저 창으로 세션 이동). */
  onPopOut?: () => void;
  /** 뷰포트 전체를 채운다 (팝업 창 전용). */
  fill?: boolean;
}

const CLOSE_NOTES: Record<number, string> = {
  4403: '[노드 SSH 터미널 기능이 비활성화되어 있습니다]',
};

/**
 * 개별 노드 SSH 터미널 — 대상 노드에 **로그인 셸**을 열어 그대로 스트리밍한다.
 * k9s 콘솔과 동일한 base 툴(`SshTerminalWindow` + 백엔드 `services/ssh_pty`)을 쓰고,
 * 실행할 명령을 강제하지 않는다는 점만 다르다(운영자가 지정한 `initialCommand` 는 접속
 * 직후 한 줄 입력으로만 사용).
 */
export function NodeSshTerminal({ params, onClose, onPopOut, fill }: NodeSshTerminalProps) {
  const url = useMemo(
    () => k8sStreamUrls.nodeSsh(getAuthToken(), params.clusterId),
    [params.clusterId],
  );
  const init = {
    host: params.host,
    port: params.port,
    username: params.username,
    password: params.authMode === 'password' ? params.password : undefined,
    privateKey: params.authMode === 'key' ? params.privateKey : undefined,
    nodeName: params.nodeName || undefined,
    initialCommand: params.initialCommand || undefined,
  };
  const subtitle = `${params.username}@${params.host}:${params.port}`
    + (params.nodeName ? ` · ${params.nodeName}` : '');

  return (
    <SshTerminalWindow
      label="ssh"
      labelClassName="text-sky-400"
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
