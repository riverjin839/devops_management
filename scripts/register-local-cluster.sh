#!/bin/bash
# ============================================================
# 로컬 테스트 클러스터를 PEP(devops_management) 에 등록
# ============================================================
# kind / k3s(Vagrant) 클러스터를 PEP API 로 등록한다.
# kubeconfig 내용을 그대로 업로드(kubeconfig_content)하고, backend 컨테이너가
# 접근 가능한 server URL 을 api_endpoint 로 지정한다.
#
# 사용법:
#   # kind 클러스터 (컨테이너 네트워크 내부 주소로 자동 등록)
#   bash scripts/register-local-cluster.sh --name kind-dev --kind k8s-monitor-dev
#
#   # Vagrant k3s (Mac 호스트 포워딩 경유)
#   bash scripts/register-local-cluster.sh \
#       --name vagrant-k3s \
#       --kubeconfig vagrant/k3s-kubeconfig.yaml \
#       --server https://host.docker.internal:6443
#
# 옵션:
#   --name NAME          PEP 에 표시될 클러스터 이름 (필수)
#   --kind KINDNAME      kind 클러스터 이름 (--internal kubeconfig 자동 사용)
#   --kubeconfig FILE    kubeconfig 파일 경로
#   --server URL         kubeconfig server / api_endpoint 강제 지정
#   --api-url URL        PEP backend 주소 (기본: http://localhost:8000)
#   --check              연결 검증 활성화 (기본: skip — 등록 후 헬스체크로 확인)
set -euo pipefail

API_URL="http://localhost:8000"
NAME=""
KIND_NAME=""
KUBECONFIG_FILE=""
SERVER=""
SKIP_CHECK="true"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --name)       NAME="$2"; shift 2 ;;
    --kind)       KIND_NAME="$2"; shift 2 ;;
    --kubeconfig) KUBECONFIG_FILE="$2"; shift 2 ;;
    --server)     SERVER="$2"; shift 2 ;;
    --api-url)    API_URL="$2"; shift 2 ;;
    --check)      SKIP_CHECK="false"; shift ;;
    *) echo "알 수 없는 옵션: $1"; exit 1 ;;
  esac
done

if [ -z "${NAME}" ]; then
  echo "ERROR: --name 은 필수입니다." >&2
  exit 1
fi

# ── kubeconfig 확보 ────────────────────────────────────────
TMP_KC="$(mktemp)"
trap 'rm -f "${TMP_KC}"' EXIT

if [ -n "${KIND_NAME}" ]; then
  echo "[1/3] kind '${KIND_NAME}' 의 internal kubeconfig 추출 중..."
  # --internal: server 를 https://<name>-control-plane:6443 으로 설정 (kind 네트워크 내부)
  kind get kubeconfig --name "${KIND_NAME}" --internal > "${TMP_KC}"
elif [ -n "${KUBECONFIG_FILE}" ]; then
  echo "[1/3] kubeconfig 파일 사용: ${KUBECONFIG_FILE}"
  cp "${KUBECONFIG_FILE}" "${TMP_KC}"
else
  echo "ERROR: --kind 또는 --kubeconfig 중 하나는 필요합니다." >&2
  exit 1
fi

# ── server URL 재작성 (지정 시) ────────────────────────────
if [ -n "${SERVER}" ]; then
  echo "      server URL → ${SERVER} 로 재작성"
  # 'server:' 로 시작하는 라인을 모두 치환 (들여쓰기 보존)
  python3 - "${TMP_KC}" "${SERVER}" <<'PY'
import re, sys
path, server = sys.argv[1], sys.argv[2]
with open(path) as f:
    txt = f.read()
txt = re.sub(r'(\n\s*server:\s*).*', r'\g<1>' + server, txt)
with open(path, 'w') as f:
    f.write(txt)
PY
fi

# ── api_endpoint 결정 (지정 server > kubeconfig 의 server) ──
API_ENDPOINT="${SERVER}"
if [ -z "${API_ENDPOINT}" ]; then
  API_ENDPOINT="$(python3 - "${TMP_KC}" <<'PY'
import re, sys
with open(sys.argv[1]) as f:
    m = re.search(r'\n\s*server:\s*(\S+)', f.read())
print(m.group(1) if m else "")
PY
)"
fi
echo "      api_endpoint = ${API_ENDPOINT}"

# ── 등록 payload 생성 (JSON 안전 인코딩) ───────────────────
echo "[2/3] PEP 에 클러스터 등록 중 (${API_URL})..."
PAYLOAD="$(python3 - "${TMP_KC}" "${NAME}" "${API_ENDPOINT}" "${SKIP_CHECK}" <<'PY'
import json, sys
kc_path, name, endpoint, skip = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
with open(kc_path) as f:
    content = f.read()
print(json.dumps({
    "name": name,
    "api_endpoint": endpoint,
    "kubeconfig_content": content,
    "skip_connectivity_check": skip.lower() == "true",
}))
PY
)"

# --max-time: 백엔드가 멈춰도 무한 대기하지 않고 에러를 드러낸다.
RESP="$(curl -s --max-time 40 -w $'\n__HTTP__%{http_code}' -X POST "${API_URL}/api/v1/clusters" \
  -H "Content-Type: application/json" \
  -d "${PAYLOAD}")"
CURL_RC=$?
HTTP_CODE="$(printf '%s' "${RESP}" | sed -n 's/.*__HTTP__\([0-9]*\)$/\1/p')"
RESP="$(printf '%s' "${RESP}" | sed 's/__HTTP__[0-9]*$//')"

if [ "${CURL_RC}" -ne 0 ]; then
  echo "ERROR: 등록 요청 실패 (curl rc=${CURL_RC}). 40초 내 응답 없음(타임아웃) 또는 연결 불가." >&2
  echo "  점검: 1) 백엔드가 최신 코드로 재빌드됐는지  2) docker-compose logs -f backend 로 요청 처리 로그" >&2
  exit 1
fi

echo "      HTTP ${HTTP_CODE} 응답: ${RESP}"

CLUSTER_ID="$(echo "${RESP}" | python3 -c 'import sys,json;
try: print(json.load(sys.stdin).get("id",""))
except Exception: print("")' 2>/dev/null || true)"

if [ -z "${CLUSTER_ID}" ]; then
  echo "ERROR: 클러스터 등록 실패 — 위 응답을 확인하세요." >&2
  exit 1
fi

echo "      클러스터 ID: ${CLUSTER_ID}"

# ── 즉시 헬스체크 실행 (실제 연결 검증) ────────────────────
echo "[3/3] 헬스체크 실행 중..."
curl -s --max-time 60 -X POST "${API_URL}/api/v1/daily-check/run/${CLUSTER_ID}?schedule_type=manual" \
  | python3 -m json.tool 2>/dev/null || echo "(헬스체크 트리거 완료 — 대시보드에서 결과 확인)"

echo ""
echo "✓ 완료: '${NAME}' 등록됨"
echo "  대시보드: http://localhost:5173"
echo "  API 문서: http://localhost:8000/docs"
