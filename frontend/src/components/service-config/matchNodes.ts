// 노드 패턴(glob, 쉼표로 여러 개) 일치 — 서버 `node_param_watch.rules.node_matches`(fnmatchcase)와 같은 규칙.
function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
  return new RegExp(`^${esc}$`);
}

export function matchNodes(pattern: string, nodes: string[]): string[] {
  const pats = pattern.split(',').map((p) => p.trim()).filter(Boolean).map(globToRegExp);
  if (pats.length === 0) return [];
  return nodes.filter((n) => pats.some((re) => re.test(n)));
}
