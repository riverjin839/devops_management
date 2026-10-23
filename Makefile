.PHONY: help install dev build test clean docker-up docker-down \
	k8s-dev k8s-prod k8s-delete-dev k8s-delete-prod k8s-status skaffold-dev \
	kind-up kind-reload kind-down kind-status kind-logs \
	monitoring-status monitoring-test monitoring-port-forward monitoring-images

help:
	@echo "K8s Daily Monitor - Available commands:"
	@echo ""
	@echo "  make install         - Install all dependencies"
	@echo "  make dev             - Start development servers"
	@echo "  make build           - Build for production"
	@echo "  make test            - Run all tests"
	@echo "  make clean           - Clean build artifacts"
	@echo ""
	@echo "Docker Commands:"
	@echo "  make docker-up       - Start Docker Compose"
	@echo "  make docker-down     - Stop Docker Compose"
	@echo ""
	@echo "kind 로컬 배포 (Mac 개발용 - 이 명령을 사용하세요):"
	@echo "  make kind-up         - 최초 환경 구축 (kind 클러스터 + 빌드 + 배포)"
	@echo "  make kind-reload     - 코드 수정 후 재빌드 & 재배포"
	@echo "  make kind-status     - Pod 상태 확인"
	@echo "  make kind-logs       - 백엔드 로그 스트리밍"
	@echo "  make kind-down       - kind 클러스터 전체 삭제"
	@echo ""
	@echo "  접속:  Frontend http://localhost:30080"
	@echo "        Backend  http://localhost:30800/docs"
	@echo ""
	@echo "Kubernetes Commands (실제 클러스터용):"
	@echo "  make k8s-dev         - Deploy to Kubernetes (dev)"
	@echo "  make k8s-prod        - Deploy to Kubernetes (prod)"
	@echo "  make k8s-delete-dev  - Delete dev deployment"
	@echo "  make k8s-delete-prod - Delete prod deployment"
	@echo "  make k8s-status      - Show Kubernetes resources status"
	@echo "  make skaffold-dev    - Start Skaffold development mode"
	@echo ""
	@echo "Monitoring Commands:"
	@echo "  make monitoring-status       - Check Prometheus/Grafana pod status"
	@echo "  make monitoring-test         - Test PromQL queries"
	@echo "  make monitoring-port-forward - Port-forward Prometheus & Grafana"
	@echo "  make monitoring-images       - List images for airgap"
	@echo ""

# Install dependencies
install:
	@echo "Installing backend dependencies..."
	cd backend && pip install -r requirements.txt
	@echo "Installing frontend dependencies..."
	cd frontend && npm install
	@echo "Done!"

# Development
dev:
	@echo "Starting development servers..."
	@make -j2 dev-backend dev-frontend

dev-backend:
	cd backend && uvicorn app.main:app --reload --port 8000

dev-frontend:
	cd frontend && npm run dev

# Build
build:
	@echo "Building frontend..."
	cd frontend && npm run build
	@echo "Done!"

# Test
test:
	@echo "Running backend tests..."
	cd backend && pytest -v
	@echo "Running frontend lint..."
	cd frontend && npm run lint

# Clean
clean:
	rm -rf frontend/dist
	rm -rf frontend/node_modules
	rm -rf backend/__pycache__
	rm -rf backend/.pytest_cache
	find . -type d -name "__pycache__" -exec rm -rf {} + 2>/dev/null || true
	find . -type f -name "*.pyc" -delete

# Docker
docker-up:
	docker-compose up -d
	@echo "Services started. Frontend: http://localhost:5173, API: http://localhost:8000"

docker-down:
	docker-compose down

docker-logs:
	docker-compose logs -f

docker-rebuild:
	docker-compose down
	docker-compose build --no-cache
	docker-compose up -d

# ── kind 로컬 배포 (Mac 개발용) ───────────────────────────────────────────────
kind-up:
	@echo "=== kind 로컬 환경 구축 ==="
	@echo "Frontend: http://localhost:30080  Backend: http://localhost:30800"
	@bash scripts/deploy/kind-setup.sh up

kind-reload:
	@echo "=== 코드 재빌드 & 재배포 ==="
	@bash scripts/deploy/kind-setup.sh reload

kind-down:
	@echo "=== kind 클러스터 삭제 ==="
	@bash scripts/deploy/kind-setup.sh destroy

kind-status:
	@bash scripts/deploy/kind-setup.sh status

kind-logs:
	@bash scripts/deploy/kind-setup.sh logs backend

# Kubernetes Deployments (실제 클러스터용)
k8s-dev:
	@echo "Deploying to Kubernetes (dev environment)..."
	kubectl apply -k deploy/k8s/overlays/dev
	@echo ""
	@echo "Waiting for deployments..."
	kubectl rollout status deployment/dev-backend -n k8s-monitor-dev --timeout=300s || true
	kubectl rollout status deployment/dev-frontend -n k8s-monitor-dev --timeout=300s || true
	@echo ""
	@echo "Dev deployment complete!"
	@echo "Add 'k8s-monitor-dev.local' to /etc/hosts pointing to your ingress IP"

k8s-prod:
	@echo "Deploying to Kubernetes (prod environment)..."
	kubectl apply -k deploy/k8s/overlays/prod
	@echo ""
	@echo "Waiting for deployments..."
	kubectl rollout status deployment/prod-backend -n k8s-monitor-prod --timeout=300s || true
	kubectl rollout status deployment/prod-frontend -n k8s-monitor-prod --timeout=300s || true
	@echo ""
	@echo "Prod deployment complete!"

k8s-delete-dev:
	@echo "Deleting dev Kubernetes deployment..."
	kubectl delete -k deploy/k8s/overlays/dev --ignore-not-found

k8s-delete-prod:
	@echo "Deleting prod Kubernetes deployment..."
	kubectl delete -k deploy/k8s/overlays/prod --ignore-not-found

k8s-status:
	@echo "=== Namespaces ==="
	kubectl get ns | grep k8s-monitor || echo "No k8s-monitor namespaces found"
	@echo ""
	@echo "=== Dev Environment ==="
	kubectl get all -n k8s-monitor-dev 2>/dev/null || echo "Dev namespace not found"
	@echo ""
	@echo "=== Prod Environment ==="
	kubectl get all -n k8s-monitor-prod 2>/dev/null || echo "Prod namespace not found"

k8s-logs-dev:
	kubectl logs -l app.kubernetes.io/part-of=k8s-daily-monitor -n k8s-monitor-dev --tail=100 -f

k8s-logs-prod:
	kubectl logs -l app.kubernetes.io/part-of=k8s-daily-monitor -n k8s-monitor-prod --tail=100 -f

# Skaffold for local Kubernetes development
skaffold-dev:
	skaffold dev --profile=dev --port-forward

skaffold-run:
	skaffold run --profile=dev

skaffold-delete:
	skaffold delete --profile=dev

# Monitoring Stack
monitoring-status:
	@bash scripts/deploy/setup-monitoring.sh status

monitoring-test:
	@bash scripts/deploy/setup-monitoring.sh test

monitoring-port-forward:
	@bash scripts/deploy/setup-monitoring.sh port-forward

monitoring-images:
	@bash scripts/deploy/setup-monitoring.sh images
