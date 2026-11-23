# PEP 노드 에이전트 — 정적(musl) Rust 바이너리만 담은 전용 이미지(셸·패키지·인터프리터 없음).
# 빌드:  docker build -t node-agent agent-rs
# 실행:  ENTRYPOINT 가 에이전트다(command 불필요). 점검은 `--dry-run` 인자로 — distroless 에는 셸이 없어
#        `kubectl exec` 대신 `kubectl debug` 를 쓴다(deploy/k8s/node-param-agent/README.md).
FROM rust:1.97-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
# 의존성 레이어 캐시 — 소스 없이 먼저 의존 crate 만 빌드한다.
COPY Cargo.toml Cargo.lock ./
RUN mkdir src && echo 'fn main(){}' > src/main.rs && cargo build --release --locked && rm -rf src
COPY src ./src
RUN touch src/main.rs && cargo build --release --locked

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /src/target/release/pep-node-agent /pep-node-agent
USER 65534:65534
ENTRYPOINT ["/pep-node-agent"]
