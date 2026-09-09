import {
  Hexagon, Terminal, Globe, Activity, Camera, TerminalSquare, Code2, Workflow, Hand,
} from 'lucide-react';

// "Deep Check/Addon/핵심/수동" 같은 내부 구현 용어 대신, 실제로 어떤 기술로 점검을 수행하는지
// 사용자가 알아보는 이름으로 노출한다 (백엔드 CheckMatrixItem.execTech, registry.py 의
// DeepCheckTypeSpec.exec_tech / checkers.EXEC_TECH / core_bundle=k8s_api / manual 에서 옴).
// `ExecTechBadge`(배지 렌더)와 `CheckMatrixItemFormModal`(등록 마법사 실행기술 선택)이 공유한다.
export const EXEC_TECH_META: Record<string, { label: string; hint: string; icon: typeof Hexagon }> = {
  k8s_api: { label: 'K8s API', hint: 'Kubernetes API 호출로 점검', icon: Hexagon },
  kubectl: { label: 'kubectl', hint: 'kubectl 명령으로 점검', icon: Terminal },
  http: { label: 'HTTP', hint: 'HTTP 프로브로 점검', icon: Globe },
  promql: { label: 'PromQL', hint: 'PromQL 질의로 점검', icon: Activity },
  snapshot: { label: '스냅샷', hint: '수집된 스냅샷 데이터를 판독', icon: Camera },
  ssh_bash: { label: 'bash(SSH)', hint: 'SSH 로 접속해 bash shell 명령 실행', icon: TerminalSquare },
  ssh_python: { label: 'python(SSH)', hint: 'SSH 로 접속해 python 스크립트 실행', icon: Code2 },
  ansible: { label: 'Ansible', hint: 'Ansible 플레이북으로 실행', icon: Workflow },
  manual: { label: '수동 입력', hint: '자동 실행 없음 — 값을 직접 입력', icon: Hand },
};
