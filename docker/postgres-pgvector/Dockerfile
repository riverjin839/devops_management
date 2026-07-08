# Postgres 15 (Alpine) + pgvector 확장.
#
# k8s/base/postgres/statefulset.yaml 의 postgres:15-alpine 과 동일한 베이스(musl libc)를
# 유지한 채 pgvector 만 소스 빌드로 추가한다 — Docker Hub 의 공식 pgvector/pgvector:pg15
# 이미지(Debian/glibc 베이스)로 통째로 바꾸면 컬레이션(정렬 순서) 차이로 기존 인덱스가
# 깨질 수 있어, 베이스를 바꾸지 않는 쪽을 택했다.
#
# GHCR 프록시로만 이미지를 받을 수 있는 폐쇄망 배포 전제 — 이 이미지도 앱 이미지(backend/
# frontend)와 같은 ghcr.io/<owner>/<repo>/ 네임스페이스에 올려 기존 pull 경로를 그대로 쓴다.
# 빌드/게시는 .github/workflows/postgres-pgvector.yml 참고.
ARG PG_VERSION=15
ARG PGVECTOR_VERSION=v0.7.4

FROM postgres:${PG_VERSION}-alpine AS builder
ARG PGVECTOR_VERSION

RUN apk add --no-cache --virtual .build-deps \
      build-base \
      clang15 \
      llvm15 \
      git \
      postgresql-dev \
  && git clone --branch "${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
  && make -C /tmp/pgvector OPTFLAGS="" \
  && make -C /tmp/pgvector install \
  && apk del .build-deps \
  && rm -rf /tmp/pgvector

FROM postgres:${PG_VERSION}-alpine
COPY --from=builder /usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=builder /usr/local/share/postgresql/extension/ /usr/local/share/postgresql/extension/
