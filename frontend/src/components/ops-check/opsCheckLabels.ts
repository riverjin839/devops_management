/** 운영 점검 카탈로그 공용 라벨 — 점검 항목 표·실행 확인 다이얼로그(점검 ▸ 점검 항목, 개요 「전체 점검」)가 같이 쓴다. */
export const CATEGORY_LABEL: Record<string, string> = {
  os: 'OS', k8s: 'K8s', storage: 'Storage', network: 'Network', app: '앱서비스',
};

export const SOURCE_LABEL: Record<string, string> = {
  deep_check: '점검', addon: '애드온', batch_job: 'SSH', playbook: 'Ansible',
};

export const itemKey = (i: { source: string; itemRefId: string }) => `${i.source}::${i.itemRefId}`;
