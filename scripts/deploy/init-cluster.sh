#!/bin/bash
# ============================================
# 폐쇄망 K8s 클러스터 초기 등록 스크립트
# ============================================

API_URL="${API_URL:-http://localhost:8000}"
CLUSTER_NAME="${CLUSTER_NAME:-dev-cluster}"
CLUSTER_IP="${CLUSTER_IP:-10.61.162.101}"
API_PORT="${API_PORT:-6443}"

echo "=========================================="
echo " K8s Daily Monitor - 클러스터 등록"
echo "=========================================="
echo ""
echo "API URL: ${API_URL}"
echo "Cluster Name: ${CLUSTER_NAME}"
echo "Cluster IP: ${CLUSTER_IP}:${API_PORT}"
echo ""

# 1. 클러스터 등록
echo "[1/3] 클러스터 등록 중..."
CLUSTER_RESPONSE=$(curl -s -X POST "${API_URL}/api/v1/clusters/" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"${CLUSTER_NAME}\",
    \"api_endpoint\": \"https://${CLUSTER_IP}:${API_PORT}\",
    \"kubeconfig_path\": \"/root/.kube/config\"
  }")

echo "Response: ${CLUSTER_RESPONSE}"
CLUSTER_ID=$(echo ${CLUSTER_RESPONSE} | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)

if [ -z "$CLUSTER_ID" ]; then
  echo "클러스터 등록 실패 또는 이미 존재"
  # 기존 클러스터 조회
  CLUSTER_ID=$(curl -s "${API_URL}/api/v1/clusters/" | grep -o '"id":"[^"]*"' | head -1 | cut -d'"' -f4)
fi

echo "Cluster ID: ${CLUSTER_ID}"
echo ""

# 2. 스케줄 설정 (아침 9시, 점심 1시, 저녁 6시)
echo "[2/3] 스케줄 설정 중..."
curl -s -X PUT "${API_URL}/api/v1/daily-check/schedule/${CLUSTER_ID}" \
  -H "Content-Type: application/json" \
  -d '{
    "morning_time": "09:00",
    "morning_enabled": true,
    "noon_time": "13:00",
    "noon_enabled": true,
    "evening_time": "18:00",
    "evening_enabled": true,
    "timezone": "Asia/Seoul"
  }' | python3 -m json.tool 2>/dev/null || echo "스케줄 설정 완료"

echo ""

# 3. 즉시 체크 실행
echo "[3/3] 헬스 체크 실행 중..."
CHECK_RESULT=$(curl -s -X POST "${API_URL}/api/v1/daily-check/run/${CLUSTER_ID}?schedule_type=manual")

echo ""
echo "=========================================="
echo " 체크 결과"
echo "=========================================="
echo "${CHECK_RESULT}" | python3 -m json.tool 2>/dev/null || echo "${CHECK_RESULT}"

echo ""
echo "완료!"
echo ""
echo "대시보드 접속: ${API_URL}"
echo "API 문서: ${API_URL}/docs"
