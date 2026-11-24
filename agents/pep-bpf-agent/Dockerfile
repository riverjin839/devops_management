# pep-bpf-agent — musl 정적 바이너리 하나만 담은 이미지(scratch). 루트 CA 는 바이너리에 내장(webpki-roots).
#   docker build -t <registry>/devops_management-bpf-agent:<ver> agents/pep-bpf-agent
FROM rust:1.90-alpine AS build
RUN apk add --no-cache musl-dev gcc
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
RUN cargo build --release --locked

FROM scratch
COPY --from=build /src/target/release/pep-bpf-agent /pep-bpf-agent
ENTRYPOINT ["/pep-bpf-agent"]
