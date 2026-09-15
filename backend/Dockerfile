FROM python:3.11-alpine

WORKDIR /app

# ── 폐쇄망 Nexus 프록시 지원 ──
# 사용법: docker build --build-arg ALPINE_MIRROR_URL=http://nexus:8081/repository/alpine-proxy \
#                      --build-arg PIP_INDEX_URL=http://nexus:8081/repository/pypi-proxy/simple \
#                      --build-arg PIP_TRUSTED_HOST=nexus \
#                      --build-arg KUBECTL_MIRROR_URL=http://nexus:8081/repository/kubernetes-raw/release .
ARG ALPINE_MIRROR_URL=""
ARG PIP_INDEX_URL=""
ARG PIP_TRUSTED_HOST=""
ARG KUBECTL_VERSION="v1.30.0"
ARG KUBECTL_MIRROR_URL=""
ARG HUBBLE_VERSION="v1.16.3"
ARG HUBBLE_MIRROR_URL=""
ARG TARGETARCH="amd64"

# Alpine apk 미러를 Nexus 프록시로 변경 (폐쇄망)
RUN if [ -n "${ALPINE_MIRROR_URL}" ]; then \
        echo "${ALPINE_MIRROR_URL}/v$(cat /etc/alpine-release | cut -d. -f1,2)/main" > /etc/apk/repositories && \
        echo "${ALPINE_MIRROR_URL}/v$(cat /etc/alpine-release | cut -d. -f1,2)/community" >> /etc/apk/repositories; \
    fi

# 시스템 패키지 (ansible SSH 연결, kubectl 다운로드용)
# - ansible / ansible-core 는 pip 로 설치하므로 여기서는 아래 의존성만 둔다.
# - py3-cryptography 등 ansible-core 빌드 의존성은 alpine 의 python 3.11 패키지로 충당.
RUN apk add --no-cache openssh-client sshpass curl ca-certificates \
    gcc musl-dev libffi-dev openssl-dev python3-dev cargo

# kubectl 설치 — 체커/자동업데이트에서 subprocess 로 호출
# 폐쇄망이면 KUBECTL_MIRROR_URL 로 Nexus raw 저장소를 가리키게 함
RUN set -eux; \
    BASE="${KUBECTL_MIRROR_URL:-https://dl.k8s.io/release}"; \
    curl -fsSL -o /usr/local/bin/kubectl \
        "${BASE}/${KUBECTL_VERSION}/bin/linux/${TARGETARCH}/kubectl"; \
    chmod +x /usr/local/bin/kubectl; \
    kubectl version --client --output=yaml || true

# hubble CLI 설치 — Cilium Hubble Relay 로부터 flow 조회용
# 폐쇄망이면 HUBBLE_MIRROR_URL 로 Nexus raw 저장소를 가리키게 함
RUN set -eux; \
    BASE="${HUBBLE_MIRROR_URL:-https://github.com/cilium/hubble/releases/download}"; \
    curl -fsSL -o /tmp/hubble.tar.gz \
        "${BASE}/${HUBBLE_VERSION}/hubble-linux-${TARGETARCH}.tar.gz" \
        || curl -fsSL -o /usr/local/bin/hubble \
            "${BASE}/${HUBBLE_VERSION}/hubble-linux-${TARGETARCH}"; \
    if [ -f /tmp/hubble.tar.gz ]; then \
        tar -xzf /tmp/hubble.tar.gz -C /usr/local/bin hubble \
        && rm -f /tmp/hubble.tar.gz; \
    fi; \
    chmod +x /usr/local/bin/hubble; \
    hubble version || true

# pip 프록시 설정 (폐쇄망)
RUN if [ -n "${PIP_INDEX_URL}" ]; then \
        pip config set global.index-url "${PIP_INDEX_URL}" && \
        pip config set global.trusted-host "${PIP_TRUSTED_HOST:-$(echo ${PIP_INDEX_URL} | sed 's|https\?://\([^:/]*\).*|\1|')}"; \
    fi

# 의존성 설치
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# 앱 복사
COPY . .

# 포트 노출
EXPOSE 8000

# 실행
# --workers 2: 단일 프로세스는 sync 라우트(전체의 89%)가 전부 같은 anyio 스레드풀을
# 나눠 쓰므로, 로그 스트림 등 오래 걸리는 요청 하나가 한 프로세스의 슬롯을 다 먹으면
# 그 프로세스가 받는 나머지 요청 전체가 멈춘다. 워커 2개(=replicas 2 와 동일 배수)로
# 그 장애가 최소 절반의 용량에만 미치게 한다. celery worker/beat 는 별도 컨테이너/
# 커맨드로 이 이미지를 쓰므로 영향 없음.
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "2"]
