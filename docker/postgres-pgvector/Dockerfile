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

# `postgresql-dev` 를 apk 로 설치하지 않는다 — 의도적인 선택이다.
#
# postgres:15-alpine 은 Alpine 이 15 버전용 apt/apk 패키지를 제공하지 않기 때문에(Alpine
# 저장소엔 postgresql16-dev/17-dev 까지만 있고 15/18 은 없음) Postgres 를 소스에서 직접
# 빌드해 /usr/local 에 설치한 이미지다. pg_config 와 확장 빌드용 헤더(-I/usr/local/include/
# postgresql/server) 는 이미 그 소스 빌드 결과물로 base 이미지에 들어있다.
#
# 여기서 apk add postgresql-dev 를 하면 Alpine 롤링 저장소가 최신으로 해석한 전혀 다른
# 메이저 버전(postgresql18-dev) 이 설치되어 실제 실행되는 pg15 바이너리와 헤더/ABI 버전이
# 어긋나는 위험이 생긴다.
#
# with_llvm=no — postgres:15-alpine 자체가 --with-llvm 으로 빌드돼 있어(base 이미지의
# pg_config 응답이라 apk 설치 여부와 무관), pgvector 의 make 가 기본적으로 JIT 용 LLVM
# bitcode(.bc) 산출물까지 만들려고 시도한다. 이 bitcode 빌드는 pg_config 가 가리키는
# "clang-21" 바이너리를 요구하는데 이 base 이미지엔 clang 자체가 아예 없어 항상 실패한다
# (make: clang-21: No such file or directory). vector 확장의 유사도 검색 기능 자체에는
# JIT bitcode 가 필요 없으므로, pgvector 가 제공하는 `with_llvm=no` 플래그로 이 빌드
# 스텝을 건너뛴다.
RUN apk add --no-cache --virtual .build-deps \
      build-base \
      git \
  && git clone --branch "${PGVECTOR_VERSION}" --depth 1 https://github.com/pgvector/pgvector.git /tmp/pgvector \
  && make -C /tmp/pgvector OPTFLAGS="" with_llvm=no \
  && make -C /tmp/pgvector install with_llvm=no \
  && apk del .build-deps \
  && rm -rf /tmp/pgvector

FROM postgres:${PG_VERSION}-alpine
COPY --from=builder /usr/local/lib/postgresql/ /usr/local/lib/postgresql/
COPY --from=builder /usr/local/share/postgresql/extension/ /usr/local/share/postgresql/extension/
