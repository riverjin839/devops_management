"""Cilium BPF 조회 메모리 — conntrack 앞부분만 읽기(서비스 토폴로지), 원본은 다운로드 스트림으로만.

가짜 kubectl(셸 스크립트)로 실제 프로세스를 띄워 Popen·읽기 중단·스트리밍·시간 초과를 확인한다.
"""
import json
import os
import stat
import time

import pytest

from app.services import cilium_trace_service as cts


def _fake_kubectl(tmp_path, body: str):
    p = tmp_path / "kubectl"
    p.write_text("#!/bin/sh\n" + body + "\n")
    p.chmod(p.stat().st_mode | stat.S_IEXEC)
    return str(p)


@pytest.fixture
def fake(monkeypatch, tmp_path):
    def _use(body):
        path = _fake_kubectl(tmp_path, body)
        monkeypatch.setattr(cts, "_kubectl_base", lambda kc: [path])
    return _use


def test_ct_head_reads_only_needed_lines_and_stops(fake):
    # 끝없이 conntrack 줄을 내는 프로세스 — 앞 50줄만 읽고 끊어야 한다
    fake('i=0; while true; do i=$((i+1)); echo "TCP OUT 10.0.0.$((i%250)):$i -> 10.0.1.1:80 expires=1"; done')
    t0 = time.monotonic()
    lines, err = cts.bpf_ct_head("kc", 50, pod_name="cilium-a")
    assert err is None and len(lines) == 50 and "10.0.0.1:1 -> 10.0.1.1:80" in lines[0]
    assert time.monotonic() - t0 < 5


def test_ct_head_times_out(fake):
    fake("sleep 30")
    t0 = time.monotonic()
    lines, err = cts.bpf_ct_head("kc", 50, pod_name="cilium-a", timeout=1)
    assert lines == [] and time.monotonic() - t0 < 5


def test_raw_stream_yields_chunks_without_buffering(fake):
    fake('i=0; while [ $i -lt 20000 ]; do i=$((i+1)); echo "{\\"k\\": $i}"; done')
    pod, executed, gen, err = cts.bpf_raw_stream("kc", "ct", as_json=True, pod_name="cilium-a")
    assert err is None and pod == "cilium-a" and "-o json" in executed
    chunks = list(gen)
    assert len(chunks) > 1 and sum(len(c) for c in chunks) > 64 * 1024
    assert max(len(c) for c in chunks) <= 64 * 1024


def test_raw_stream_reports_stderr_when_command_fails(fake):
    fake('echo "error: pod not found" >&2; exit 1')
    _, _, gen, err = cts.bpf_raw_stream("kc", "nat", as_json=False, pod_name="cilium-a")
    assert err is None
    out = b"".join(gen)
    assert out.startswith(b"[cilium-dbg failed]") and b"pod not found" in out


def test_inspect_omits_raw_when_json_parsed(monkeypatch):
    body = json.dumps([{"k": i} for i in range(100)])

    class _P:
        returncode = 0
        stdout = body
        stderr = ""

    monkeypatch.setattr(cts, "_run", lambda cmd, timeout: _P())
    res = cts.bpf_inspect("kc", "ct", pod_name="cilium-a")
    assert res["raw"] == "" and res["raw_omitted"] is True and res["raw_size"] == len(body)
    assert res["is_json"] is True and len(res["parsed"]) == 100


def test_unknown_kind_and_missing_endpoint():
    assert cts.bpf_inspect("kc", "nope", pod_name="p")["error"].startswith("지원하지 않는")
    assert "endpoint_id" in cts.bpf_inspect("kc", "policy", pod_name="p")["error"]
    _, _, gen, err = cts.bpf_raw_stream("kc", "policy", as_json=True, pod_name="p")
    assert gen is None and "endpoint_id" in err


def test_topology_conntrack_uses_head(monkeypatch):
    from app.services import service_topology_service as svc

    seen = {}

    def head(kc, max_lines, **kw):
        seen["max"] = max_lines
        return ["TCP OUT 10.0.0.1:5000 -> 10.0.0.2:8080 expires=1"], None

    monkeypatch.setattr(cts, "bpf_ct_head", head)
    res = svc._traffic_from_conntrack("kc", "ns", 2000, {"10.0.0.1": "a", "10.0.0.2": "b"})
    assert seen["max"] == 2000
    assert res["status"] == "ok" and res["edges"][0]["ports"] == [8080]


def test_download_endpoint_streams_file(fake, monkeypatch):
    import uuid
    from fastapi.testclient import TestClient
    from app.main import app
    from app.auth.deps import get_current_user
    from app.routers import cilium_trace as ct_router

    fake('i=0; while [ $i -lt 5000 ]; do i=$((i+1)); echo "{\\"k\\": $i}"; done')
    monkeypatch.setattr(ct_router, "_get_cluster_kubeconfig", lambda cid, db: (None, "kc"))
    app.dependency_overrides[get_current_user] = lambda: type("U", (), {"id": uuid.uuid4(), "role": "viewer",
                                                                        "username": "v", "is_active": True})()
    try:
        cid = uuid.uuid4()
        r = TestClient(app).post(f"/api/v1/cilium/{cid}/bpf-inspect/download",
                                 json={"cluster_id": str(cid), "kind": "ct", "pod_name": "cilium-a", "format": "json"})
        assert r.status_code == 200, r.text
        assert 'filename="cilium-bpf-ct-cilium-a.json"' in r.headers["content-disposition"]
        assert r.content.count(b"\n") == 5000
        r = TestClient(app).post(f"/api/v1/cilium/{cid}/bpf-inspect/download",
                                 json={"cluster_id": str(cid), "kind": "policy", "pod_name": "cilium-a"})
        assert r.status_code == 422 and "endpoint_id" in r.json()["detail"]
    finally:
        app.dependency_overrides.pop(get_current_user, None)
