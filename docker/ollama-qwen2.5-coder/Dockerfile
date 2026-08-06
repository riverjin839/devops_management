# Ollama + qwen2.5-coder:7b (pre-baked) — CPU 전용 K8s 노드용 인클러스터 LLM 이미지.
#
# 이전에 수동으로 만들어 push 했던 ghcr.io/riverjin839/ollama-qwen2.5-coder:7b 는 실제로는
# 모델이 구워지지 않은 채 배포돼 있었다 (런타임 파드에서 /root/.ollama/models 자체가 없고
# `ollama list` 도 빈 목록 — 2026-08 확인). 빌드 스크립트가 이 저장소 밖에 있어 정확한 원인은
# 알 수 없지만, 흔한 실패 패턴은 `ollama serve` 와 `ollama pull` 이 서로 다른 RUN 레이어로
# 나뉘어 pull 시점에 서버가 없거나, pull 결과가 검증 없이 커밋되는 경우다.
#
# 이 Dockerfile 은 그 두 가지를 구조적으로 막는다:
#   1. serve 기동 → 준비 대기 → pull → 검증을 **하나의 RUN 레이어**에서 끝낸다.
#   2. `ollama list` 로 모델이 실제로 잡혔는지 빌드 타임에 검증하고, 없으면 빌드 자체를
#      실패시킨다 — "이미지는 성공적으로 빌드됐는데 모델은 없는" 상황을 원천 차단.
#
# 빌드/게시는 .github/workflows/ollama-qwen2.5-coder.yml 이 담당한다 (GITHUB_TOKEN 사용,
# 별도 PAT/수동 docker push 불필요) — docker/ollama-qwen2.5-coder/** 변경 시 자동 실행.
ARG OLLAMA_BASE_TAG=latest
FROM ollama/ollama:${OLLAMA_BASE_TAG}

ARG OLLAMA_MODEL=qwen2.5-coder:7b
ENV OLLAMA_HOST=0.0.0.0

RUN set -eux; \
    ollama serve & \
    server_pid=$!; \
    tries=0; \
    until ollama list >/dev/null 2>&1; do \
        tries=$((tries + 1)); \
        if [ "$tries" -gt 60 ]; then \
            echo "ERROR: ollama serve did not become ready in time" >&2; \
            exit 1; \
        fi; \
        sleep 2; \
    done; \
    ollama pull "${OLLAMA_MODEL}"; \
    ollama list | grep -F "${OLLAMA_MODEL}" || { \
        echo "ERROR: model '${OLLAMA_MODEL}' missing from 'ollama list' after pull — build must fail, not ship empty" >&2; \
        exit 1; \
    }; \
    du -sh /root/.ollama/models >&2; \
    kill "$server_pid"; \
    wait "$server_pid" 2>/dev/null || true

EXPOSE 11434

# 부팅 스크립트는 curl 등 외부 바이너리에 의존하지 않고 ollama 자체 명령으로 준비 상태를
# 판단한다 — curl 이 이미지에 없으면 무한 "Waiting..." 루프에 빠지는 문제를 피한다.
# 실제 트래픽 게이팅은 k8s readinessProbe(httpGet /, kubelet 이 직접 체크)가 담당하므로
# 이 루프는 로그 가시성 용도다.
CMD ["/bin/sh", "-c", "ollama serve & until ollama list >/dev/null 2>&1; do sleep 1; done; echo 'Ollama server ready. Pre-baked model:'; ollama list; wait"]
