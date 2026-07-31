"""k8s_allocation 의 수량 파싱 / 유효 리소스 계산 / RS 해시 strip 단위 테스트.

감사에서 발견된 버그의 회귀 방지:
- BE-1: init 컨테이너(순차 실행 → max) / 네이티브 사이드카(restartPolicy=Always → 합산) /
  spec.overhead 가 유효 request 계산에서 누락되면 slack(여유)이 과대평가된다.
- BE-5: nanocores("451331n") 처럼 1 미만 millicore 가 절삭(int())으로 0 이 되던 문제 —
  반올림으로 교체.
- BE-6: 실제 K8s pod-template-hash 알파벳(bcdfghjklmnpqrstvwxz2456789, hex 아님)에 대해
  _strip_hash 가 동작하는지.
"""
from types import SimpleNamespace as NS

from app.routers import k8s_allocation as ka


def _res(cpu_req=None, mem_req=None, cpu_lim=None, mem_lim=None):
    reqs = {}
    lims = {}
    if cpu_req is not None:
        reqs["cpu"] = cpu_req
    if mem_req is not None:
        reqs["memory"] = mem_req
    if cpu_lim is not None:
        lims["cpu"] = cpu_lim
    if mem_lim is not None:
        lims["memory"] = mem_lim
    return NS(requests=reqs or None, limits=lims or None)


def _container(name, **kw):
    return NS(name=name, resources=_res(**kw))


# ── _cpu_m / _mem_b ──────────────────────────────────────────────────────────
def test_cpu_m_parses_millicores_and_cores():
    assert ka._cpu_m("500m") == 500
    assert ka._cpu_m("1") == 1000
    assert ka._cpu_m("1.5") == 1500


def test_cpu_m_rounds_nanocores_instead_of_truncating():
    # 1 나노코어 = 1e-6 밀리코어. 1750000n = 1.75m → 절삭(int())이면 1, 반올림이면 2.
    assert ka._cpu_m("1750000n") == 2
    # 600000n = 0.6m 은 절삭하면 0(usage 완전 소실), 반올림이면 1 — 컨테이너가 많을수록
    # 절삭 오차가 누적된다(감사 BE-5).
    assert ka._cpu_m("600000n") == 1


def test_cpu_m_parse_failure_returns_zero_not_raise():
    assert ka._cpu_m("not-a-quantity") == 0
    assert ka._cpu_m("") == 0
    assert ka._cpu_m(None) == 0


def test_mem_b_parses_binary_and_decimal_units():
    assert ka._mem_b("1Ki") == 1024
    assert ka._mem_b("1Mi") == 1024 ** 2
    assert ka._mem_b("128974848") == 128974848


def test_mem_b_parse_failure_returns_zero_not_raise():
    assert ka._mem_b("garbage") == 0


# ── _strip_hash ──────────────────────────────────────────────────────────────
def test_strip_hash_handles_real_pod_template_hash_alphabet():
    # rand.SafeEncodeString 알파벳은 hex 가 아니다 — k,m,n,p,q,r,s,t,v,w,x,z,7,9 등을 포함.
    assert ka._strip_hash("myapp-7d9f8c6b5k") == "myapp"
    assert ka._strip_hash("web-frontend-c4f9d8b7t9") == "web-frontend"


def test_strip_hash_no_match_returns_unchanged():
    assert ka._strip_hash("standalone-rs") == "standalone-rs"


# ── _pod_effective_resources ──────────────────────────────────────────────────
def test_effective_resources_regular_containers_only():
    spec = NS(containers=[_container("app", cpu_req="200m", mem_req="256Mi")],
              init_containers=None, overhead=None)
    rc, rm, lc, lm = ka._pod_effective_resources(spec)
    assert (rc, rm) == (200, 256 * 1024 ** 2)


def test_effective_resources_includes_native_sidecar():
    # 사이드카(init, restartPolicy=Always) 는 파드 수명 내내 상주 — 일반 컨테이너와 합산돼야 함.
    sidecar = NS(name="istio-proxy", restart_policy="Always",
                 resources=_res(cpu_req="100m", mem_req="128Mi"))
    spec = NS(containers=[_container("app", cpu_req="200m", mem_req="256Mi")],
              init_containers=[sidecar], overhead=None)
    rc, rm, lc, lm = ka._pod_effective_resources(spec)
    assert rc == 300, "사이드카 CPU request 가 합산되지 않음(메시 주입 클러스터에서 slack 과대평가 원인)"
    assert rm == (256 + 128) * 1024 ** 2


def test_effective_resources_regular_init_uses_max_not_sum():
    # 순차 실행되는 일반 init 컨테이너는 최대값만 스케줄러 예산에 반영된다.
    big_init = NS(name="migrate", restart_policy=None, resources=_res(cpu_req="2", mem_req="1Gi"))
    small_init = NS(name="wait-for-db", restart_policy=None, resources=_res(cpu_req="50m"))
    spec = NS(containers=[_container("app", cpu_req="100m", mem_req="128Mi")],
              init_containers=[big_init, small_init], overhead=None)
    rc, rm, lc, lm = ka._pod_effective_resources(spec)
    assert rc == 2000, "일반 init 컨테이너 최대 CPU(2 코어)가 반영되지 않음"
    assert rm == 1024 ** 3, "init 컨테이너 최대 메모리(1Gi)가 반영되지 않음(app 의 128Mi 보다 커야 함)"


def test_effective_resources_includes_overhead():
    spec = NS(containers=[_container("app", cpu_req="100m", mem_req="128Mi")],
              init_containers=None, overhead={"cpu": "50m", "memory": "16Mi"})
    rc, rm, lc, lm = ka._pod_effective_resources(spec)
    assert rc == 150 and rm == (128 + 16) * 1024 ** 2


def test_effective_resources_none_spec_is_zero():
    assert ka._pod_effective_resources(None) == (0, 0, 0, 0)
