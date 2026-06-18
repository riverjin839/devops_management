#!/bin/bash
# ============================================================
# PEP(devops_management) 로컬 테스트용 샘플 데이터 주입
# ============================================================
# 클러스터 등록(register-local-cluster.sh) 이후, 대시보드/협업/지식/인프라
# 기능을 둘러보기 위한 최소 샘플 데이터를 API 로 채워 넣는다.
#
# 자동 시드(_seed_* in main.py)되는 것 — metric_cards / playbooks /
# deep_check_definitions / lake_service_types ... — 은 backend 부팅 시 이미
# 생성되므로 여기서는 다루지 않는다. 이 스크립트는 부팅 시 비어 있는
# 협업/지식/인프라 데이터(프로젝트·작업·이슈·인프라 노드·지식 문서·운영 메모)만 채운다.
#
# 사용법:
#   bash scripts/seed-test-data.sh
#   API_URL=http://localhost:8000 PEP_USER=admin PEP_PASS=admin bash scripts/seed-test-data.sh
#
# 멱등성: 같은 이름이 이미 있어도 API 가 중복 생성하므로, 한 번만 실행하는 것을 권장.
# 재실행하면 샘플이 중복으로 쌓인다(테스트 환경이라 무방하지만 인지할 것).
set -euo pipefail

API_URL="${API_URL:-http://localhost:8000}"
PEP_USER="${PEP_USER:-admin}"
PEP_PASS="${PEP_PASS:-admin}"
TODAY="$(date +%Y-%m-%d)"
NOW="$(date +%Y-%m-%dT%H:%M:%S)"

# ── 1. 로그인 → Bearer 토큰 (쓰기 API 는 operator/admin 인증 필요) ──
echo "[1/6] 로그인 (${PEP_USER}@${API_URL}) ..."
TOKEN="$(curl -s --max-time 20 -X POST "${API_URL}/api/v1/auth/login" \
  -H "Content-Type: application/json" \
  -d "{\"username\":\"${PEP_USER}\",\"password\":\"${PEP_PASS}\"}" \
  | python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("access_token",""))
except Exception: print("")')"

if [ -z "${TOKEN}" ]; then
  echo "ERROR: 로그인 실패. backend 기동 여부와 계정(${PEP_USER}/${PEP_PASS})을 확인하세요." >&2
  exit 1
fi
AUTH=(-H "Authorization: Bearer ${TOKEN}" -H "Content-Type: application/json")

# 등록된 첫 번째 클러스터 id/name (인프라 노드·작업의 cluster_id 로 사용; 없으면 빈 값)
read -r CLUSTER_ID CLUSTER_NAME < <(curl -s --max-time 20 "${API_URL}/api/v1/clusters" \
  | python3 -c 'import sys,json
try:
    d=json.load(sys.stdin)
    rows=d.get("data",d) if isinstance(d,dict) else d
    c=rows[0]
    print(c.get("id",""), c.get("name",""))
except Exception: print("", "")')
if [ -n "${CLUSTER_ID}" ]; then
  echo "      대상 클러스터: ${CLUSTER_NAME} (${CLUSTER_ID})"
else
  echo "      등록된 클러스터 없음 — 클러스터 연관 없는 샘플만 생성합니다."
fi

post() { # post <path> <json>  → 응답 본문 출력
  curl -s --max-time 30 -X POST "${API_URL}/api/v1${1}" "${AUTH[@]}" -d "${2}"
}
id_of() { python3 -c 'import sys,json
try: print(json.load(sys.stdin).get("id",""))
except Exception: print("")'; }

# ── 2. 프로젝트 ──
echo "[2/6] 프로젝트 생성 ..."
PROJECT_ID="$(post /projects "{
  \"name\": \"플랫폼 안정화 2026-Q3\",
  \"description\": \"클러스터 헬스 개선과 운영 자동화를 위한 분기 프로젝트\",
  \"goal\": \"주요 알림 50% 감소, 점검 자동화 80% 달성\",
  \"color\": \"blue\",
  \"start_date\": \"${TODAY}\",
  \"status\": \"active\"
}" | id_of)"
echo "      project_id=${PROJECT_ID:-<none>}"

# ── 3. 작업/이슈 (work-items) ──
echo "[3/6] 작업/이슈 생성 ..."
CL_FIELDS=""
[ -n "${CLUSTER_ID}" ] && CL_FIELDS=", \"cluster_id\": \"${CLUSTER_ID}\", \"cluster_name\": \"${CLUSTER_NAME}\""
PROJ_FIELD=""
[ -n "${PROJECT_ID}" ] && PROJ_FIELD=", \"project_id\": \"${PROJECT_ID}\""

post /work-items "{
  \"type\": \"task\",
  \"assignee\": \"admin\", \"primary_assignee\": \"admin\",
  \"title\": \"Cilium Hubble 대시보드 점검 자동화\",
  \"category\": \"network\",
  \"content\": \"Hubble flow 기반 네트워크 점검을 cron 에 등록\",
  \"priority\": \"high\", \"kanban_status\": \"in_progress\",
  \"service\": \"k8s\", \"component\": \"cilium\",
  \"started_at\": \"${NOW}\"${CL_FIELDS}${PROJ_FIELD}
}" >/dev/null && echo "      + task: Cilium Hubble 점검 자동화"

post /work-items "{
  \"type\": \"issue\",
  \"assignee\": \"admin\", \"primary_assignee\": \"admin\",
  \"title\": \"노드 NotReady 간헐 발생\",
  \"category\": \"node\",
  \"content\": \"worker-2 노드가 간헐적으로 NotReady 로 전환됨. CNI 재시작으로 임시 복구.\",
  \"detail_content\": \"kubelet 로그에 PLEG 관련 경고 다수. 디스크 IO 확인 필요.\",
  \"priority\": \"high\", \"kanban_status\": \"todo\",
  \"service\": \"k8s\", \"component\": \"node\",
  \"started_at\": \"${NOW}\"${CL_FIELDS}${PROJ_FIELD}
}" >/dev/null && echo "      + issue: 노드 NotReady 간헐 발생"

post /work-items "{
  \"type\": \"task\",
  \"assignee\": \"admin\", \"primary_assignee\": \"admin\",
  \"title\": \"PromQL 카드 임계치 재조정\",
  \"category\": \"monitoring\",
  \"content\": \"CPU/메모리 카드 warning/critical 임계치를 운영 기준에 맞게 조정\",
  \"priority\": \"medium\", \"kanban_status\": \"done\",
  \"service\": \"monitoring\",
  \"started_at\": \"${NOW}\", \"closed_at\": \"${NOW}\"${CL_FIELDS}${PROJ_FIELD}
}" >/dev/null && echo "      + task: PromQL 임계치 재조정 (done)"

# ── 4. 인프라 노드 (클러스터가 있을 때만) ──
if [ -n "${CLUSTER_ID}" ]; then
  echo "[4/6] 인프라 노드 생성 ..."
  for spec in \
    "control-plane-1|master|10.10.0.11|8|32|500" \
    "worker-1|worker|10.10.0.21|16|64|1000" \
    "worker-2|worker|10.10.0.22|16|64|1000" \
    "storage-1|storage|10.10.0.31|8|32|8000"; do
    IFS='|' read -r HOST ROLE IP CPU RAM DISK <<< "${spec}"
    post /infra-nodes "{
      \"cluster_id\": \"${CLUSTER_ID}\",
      \"hostname\": \"${HOST}\", \"role\": \"${ROLE}\",
      \"ip_address\": \"${IP}\", \"rack_name\": \"RACK-A\",
      \"cpu_cores\": ${CPU}, \"ram_gb\": ${RAM}, \"disk_gb\": ${DISK},
      \"os_info\": \"Ubuntu 22.04\", \"switch_name\": \"tor-sw-01\"
    }" >/dev/null && echo "      + node: ${HOST} (${ROLE})"
  done
else
  echo "[4/6] 인프라 노드 — 클러스터 미등록으로 건너뜀"
fi

# ── 5. 지식 문서 (knowledge) ──
echo "[5/6] 지식 문서 생성 ..."
post /knowledge/pages "{
  \"kind\": \"doc\", \"category\": \"runbook\",
  \"title\": \"노드 NotReady 대응 런북\",
  \"icon\": \"📕\",
  \"summary\": \"worker 노드가 NotReady 일 때 1차 점검 절차\",
  \"content\": \"<h2>점검 순서</h2><ol><li>kubectl describe node</li><li>kubelet/CNI 로그 확인</li><li>cilium status</li><li>디스크/메모리 압박 확인</li></ol>\",
  \"tags\": [\"runbook\", \"node\", \"k8s\"],
  \"service\": \"k8s\", \"pinned\": true
}" >/dev/null && echo "      + page: 노드 NotReady 대응 런북"

# ── 6. 운영 메모 (ops-notes) ──
echo "[6/6] 운영 메모(스티키 노트) 생성 ..."
post /ops-notes "{
  \"service\": \"k8s\",
  \"title\": \"점검 시간\",
  \"content\": \"매일 09:00 / 13:00 / 18:00 (KST) 자동 헬스체크\",
  \"color\": \"yellow\", \"author\": \"admin\", \"pinned\": true
}" >/dev/null && echo "      + note: 점검 시간"
post /ops-notes "{
  \"service\": \"monitoring\",
  \"title\": \"Prometheus 주소\",
  \"content\": \"PROMETHEUS_URL 미설정 시 PromQL 카드는 offline 으로 표시됨\",
  \"color\": \"blue\", \"author\": \"admin\"
}" >/dev/null && echo "      + note: Prometheus 주소"

echo ""
echo "완료! 대시보드에서 확인: ${API_URL%/}  →  http://localhost:5173"
