// 클러스터 표준 이름 규칙 — [업무명]-[운영타입]-[속성] (하이픈 구분).
// StandardizeClusterNamesModal(이름 표준화 도구)과 clusterIconBuilder(아이콘 "속성" 층
// 자동 프리필)가 이 파싱 규칙을 공유한다.

export const CLUSTER_NAME_OPS = ['prod', 'dev', 'test', 'stage'];

export interface ClusterNameParts {
  biz: string;
  ops: string;
  attr: string;
}

/** 이름을 [업무명]-[운영타입]-[속성] 으로 분해. 표준 형식(2번째 세그먼트가 운영타입
 *  키워드)이 아니면 null. */
export function parseClusterName(name: string): ClusterNameParts | null {
  const parts = name.split('-');
  if (parts.length >= 2 && CLUSTER_NAME_OPS.includes(parts[1].toLowerCase())) {
    return { biz: parts[0], ops: parts[1].toLowerCase(), attr: parts.slice(2).join('-') };
  }
  return null;
}
