#!/usr/bin/env bash
# ============================================
# Monitoring Stack Setup Script
# Deploys Prometheus + Grafana + kube-state-metrics + node-exporter
# for the K8s Daily Monitor PromQL Insights feature.
#
# Usage:
#   bash scripts/deploy/setup-monitoring.sh status      # Check monitoring pod status
#   bash scripts/deploy/setup-monitoring.sh test         # Test Prometheus connectivity
#   bash scripts/deploy/setup-monitoring.sh port-forward # Port-forward Prometheus & Grafana
#   bash scripts/deploy/setup-monitoring.sh images       # List images to pull for airgap
# ============================================

set -euo pipefail

NAMESPACE="${NAMESPACE:-k8s-monitor}"
PROMETHEUS_PORT="${PROMETHEUS_PORT:-9090}"
GRAFANA_PORT="${GRAFANA_PORT:-3000}"

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC} $*"; }
ok()    { echo -e "${GREEN}[OK]${NC} $*"; }
warn()  { echo -e "${YELLOW}[WARN]${NC} $*"; }
err()   { echo -e "${RED}[ERROR]${NC} $*"; }

# ── Images list (for airgap pull/push) ─────────────────────
MONITORING_IMAGES=(
  "prom/prometheus:v2.51.0"
  "grafana/grafana:10.4.0"
  "registry.k8s.io/kube-state-metrics/kube-state-metrics:v2.12.0"
  "prom/node-exporter:v1.7.0"
)

cmd_status() {
  info "Checking monitoring pods in namespace: ${NAMESPACE}"
  echo ""
  kubectl get pods -n "${NAMESPACE}" -l component=monitoring -o wide 2>/dev/null || {
    warn "No monitoring pods found in namespace ${NAMESPACE}"
    return 1
  }
  echo ""
  info "Services:"
  kubectl get svc -n "${NAMESPACE}" -l component=monitoring 2>/dev/null || true
  echo ""

  # Check individual components
  for app in prometheus grafana kube-state-metrics; do
    local ready
    ready=$(kubectl get pods -n "${NAMESPACE}" -l "app=${app}" -o jsonpath='{.items[0].status.conditions[?(@.type=="Ready")].status}' 2>/dev/null || echo "")
    if [ "${ready}" = "True" ]; then
      ok "${app}: Running"
    else
      warn "${app}: Not ready (${ready:-not found})"
    fi
  done

  # node-exporter DaemonSet
  local desired actual
  desired=$(kubectl get ds -n "${NAMESPACE}" node-exporter -o jsonpath='{.status.desiredNumberScheduled}' 2>/dev/null || echo "0")
  actual=$(kubectl get ds -n "${NAMESPACE}" node-exporter -o jsonpath='{.status.numberReady}' 2>/dev/null || echo "0")
  if [ "${desired}" -gt 0 ] && [ "${desired}" = "${actual}" ]; then
    ok "node-exporter: ${actual}/${desired} nodes"
  else
    warn "node-exporter: ${actual}/${desired} nodes"
  fi
}

cmd_test() {
  info "Testing Prometheus connectivity..."
  echo ""

  # Try direct service access from within cluster
  local prom_url="http://prometheus.${NAMESPACE}.svc:9090"
  info "Prometheus URL (in-cluster): ${prom_url}"

  # Test via kubectl port-forward in background
  kubectl port-forward -n "${NAMESPACE}" svc/prometheus 19090:9090 &>/dev/null &
  local pf_pid=$!
  sleep 2

  if curl -sf "http://localhost:19090/-/healthy" > /dev/null 2>&1; then
    ok "Prometheus is healthy!"

    info "Testing PromQL queries..."
    echo ""

    # Test each default PromQL
    local queries=(
      "up"
      'sum(kube_pod_container_status_waiting_reason{reason="CrashLoopBackOff"}) OR on() vector(0)'
      '100 - (avg(rate(node_cpu_seconds_total{mode="idle"}[5m])) * 100)'
    )
    local labels=("Targets Up" "CrashLoopBackOff Count" "CPU Usage %")

    for i in "${!queries[@]}"; do
      local result
      result=$(curl -sf "http://localhost:19090/api/v1/query" --data-urlencode "query=${queries[$i]}" 2>/dev/null | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('data',{}).get('result',[]); print(r[0]['value'][1] if r else 'no data')" 2>/dev/null || echo "error")
      if [ "${result}" != "error" ]; then
        ok "${labels[$i]}: ${result}"
      else
        warn "${labels[$i]}: query failed or no data"
      fi
    done
  else
    err "Cannot reach Prometheus. Is it running?"
    err "Check: kubectl get pods -n ${NAMESPACE} -l app=prometheus"
  fi

  kill "${pf_pid}" 2>/dev/null || true
}

cmd_port_forward() {
  info "Port-forwarding monitoring services..."
  info "  Prometheus: http://localhost:${PROMETHEUS_PORT}"
  info "  Grafana:    http://localhost:${GRAFANA_PORT}  (admin/admin)"
  echo ""
  info "Press Ctrl+C to stop."
  echo ""

  kubectl port-forward -n "${NAMESPACE}" svc/prometheus "${PROMETHEUS_PORT}:9090" &
  kubectl port-forward -n "${NAMESPACE}" svc/grafana "${GRAFANA_PORT}:3000" &

  wait
}

cmd_images() {
  info "Container images required for monitoring stack:"
  info "(Pull these and push to your private registry for airgap)"
  echo ""
  for img in "${MONITORING_IMAGES[@]}"; do
    echo "  ${img}"
  done
  echo ""
  info "Example for airgap push:"
  echo "  REGISTRY=10.61.162.101:5000"
  for img in "${MONITORING_IMAGES[@]}"; do
    local name="${img%%:*}"
    local tag="${img##*:}"
    echo "  docker pull ${img}"
    echo "  docker tag ${img} \${REGISTRY}/${name}:${tag}"
    echo "  docker push \${REGISTRY}/${name}:${tag}"
  done
}

cmd_help() {
  echo "Usage: $0 <command>"
  echo ""
  echo "Commands:"
  echo "  status        Check monitoring pod status"
  echo "  test          Test Prometheus connectivity and PromQL queries"
  echo "  port-forward  Port-forward Prometheus (9090) and Grafana (3000)"
  echo "  images        List images to pull for airgap environments"
  echo "  help          Show this help"
  echo ""
  echo "Environment Variables:"
  echo "  NAMESPACE      K8s namespace (default: k8s-monitor)"
  echo "  PROMETHEUS_PORT  Local port for Prometheus (default: 9090)"
  echo "  GRAFANA_PORT     Local port for Grafana (default: 3000)"
}

# ── Main ─────────────────────────────────────────────────────
case "${1:-help}" in
  status)       cmd_status ;;
  test)         cmd_test ;;
  port-forward) cmd_port_forward ;;
  images)       cmd_images ;;
  help|--help|-h) cmd_help ;;
  *)
    err "Unknown command: $1"
    cmd_help
    exit 1
    ;;
esac
