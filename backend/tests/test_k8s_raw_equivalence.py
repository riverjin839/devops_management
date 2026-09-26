"""k8s_raw(원본 JSON 래퍼) ↔ typed 모델 동등성 — 탐색기 목록 행이 역직렬화 생략 전과 같아야 한다.

모든 KIND_MAP 종류에 대해 같은 JSON 을 (a) kubernetes 모델로 역직렬화한 객체와 (b) K8sObj 로 감싼
객체로 각각 `_build_rows` 에 넣어 결과가 동일한지 비교한다. 노드/파드 rich 행도 같은 방식으로 본다.
"""
import copy
import re

import pytest
from kubernetes import client as k8s_client

from app.routers import k8s_resources as kr
from app.services.k8s_raw import K8sObj, raw_call

TS = "2024-01-02T03:04:05Z"

# 모든 종류가 읽는 필드를 한 객체에 모은 "kitchen sink" — 종류마다 자기 필드만 읽는다.
SAMPLE = {
    "apiVersion": "v1",
    "kind": "X",
    "metadata": {
        "name": "obj-1", "namespace": "ns-a", "creationTimestamp": TS,
        "labels": {"app": "x", "node-role.kubernetes.io/control-plane": "", "node-role.kubernetes.io/infra": ""},
        "annotations": {"storageclass.kubernetes.io/is-default-class": "true"},
        "ownerReferences": [{"apiVersion": "apps/v1", "kind": "ReplicaSet", "name": "rs-1", "uid": "u"}],
        "managedFields": [{"manager": "kubectl"}],
    },
    "spec": {
        "replicas": 3, "minReplicas": 1, "maxReplicas": 5, "completions": 2,
        "schedule": "*/5 * * * *", "suspend": False,
        "type": "LoadBalancer", "clusterIP": "10.0.0.1", "externalIPs": ["5.6.7.8"],
        "ports": [{"port": 80, "protocol": "TCP"}, {"port": 53, "protocol": "UDP"}],
        "rules": [{"host": "a.example"}, {"host": "b.example"}],
        "ingressClassName": "nginx", "controller": "k8s.io/ingress-nginx",
        "policyTypes": ["Ingress", "Egress"], "storageClassName": "fast",
        "capacity": {"storage": "10Gi"}, "claimRef": {"namespace": "ns-a", "name": "pvc-1"},
        "minAvailable": 1, "maxUnavailable": "25%", "scopes": ["BestEffort"], "hard": {"cpu": "4", "pods": "10"},
        "limits": [{"type": "Container"}], "holderIdentity": "holder-1", "leaseDurationSeconds": 15,
        "validations": [{"expression": "true"}], "policyName": "pol-1",
        "unschedulable": True, "taints": [{"key": "k", "effect": "NoSchedule"}],
        "containers": [{"name": "app"}, {"name": "sidecar"}, {"name": "init-ish"}], "nodeName": "node-1",
    },
    "status": {
        "readyReplicas": 2, "replicas": 3, "desiredNumberScheduled": 4, "currentNumberScheduled": 4,
        "numberReady": 3, "updatedNumberScheduled": 4, "numberAvailable": 3,
        "phase": "Running", "capacity": {"storage": "10Gi", "cpu": "8", "memory": "32Gi"},
        "loadBalancer": {"ingress": [{"ip": "1.2.3.4"}, {"hostname": "lb.example"}]},
        "succeeded": 1, "failed": 0, "lastScheduleTime": TS, "currentReplicas": 2, "currentHealthy": 3,
        "conditions": [{"type": "Ready", "status": "True"}, {"type": "MemoryPressure", "status": "True"}],
        "nodeInfo": {"kubeletVersion": "v1.30.1"},
        "qosClass": "Burstable",
        "containerStatuses": [
            {"name": "app", "ready": True, "restartCount": 2, "image": "i", "imageID": "", "state": {"running": {"startedAt": TS}}},
            {"name": "sidecar", "ready": False, "restartCount": 5, "image": "i", "imageID": "",
             "state": {"waiting": {"reason": "CrashLoopBackOff"}}},
            {"name": "init-ish", "ready": False, "restartCount": 0, "image": "i", "imageID": "",
             "state": {"terminated": {"exitCode": 1, "reason": "Error"}}},
        ],
    },
    "data": {"a": "YQ==", "b": "Yg=="}, "type": "Opaque",
    "subsets": [{"addresses": [{"ip": "1.1.1.1"}, {"ip": "1.1.1.2"}]}, {"addresses": [{"ip": "1.1.1.3"}]}],
    "roleRef": {"apiGroup": "rbac.authorization.k8s.io", "kind": "ClusterRole", "name": "view"},
    "subjects": [{"kind": "User", "name": "u1"}, {"kind": "User", "name": "u2"}],
    "provisioner": "csi.example", "reclaimPolicy": "Delete", "value": 1000, "globalDefault": True,
    "secrets": [{"name": "s1"}], "webhooks": [{"name": "w1"}, {"name": "w2"}],
    "addressType": "IPv4", "endpoints": [{"addresses": ["1.1.1.1"]}], "handler": "runc",
}


@pytest.fixture(autouse=True)
def _no_client_validation(monkeypatch):
    """kitchen-sink 샘플은 종류마다 필수 필드가 다 채워지진 않으므로 모델 생성 검증만 끈다.
    (모델은 `Configuration()` 을 새로 만들어 쓰므로 생성자에서 끈다.)"""
    orig = k8s_client.Configuration.__init__

    def init(self, *a, **kw):
        orig(self, *a, **kw)
        self.client_side_validation = False

    monkeypatch.setattr(k8s_client.Configuration, "__init__", init)


class _Recorder:
    def __getattr__(self, name):
        def _f(*a, **kw):
            self.called = name
        return _f


def _item_model(kind: str) -> str:
    spec = kr.KIND_MAP[kind]
    rec = _Recorder()
    spec["list_all"](rec)
    api = spec["api"](k8s_client.ApiClient())
    doc = getattr(api, rec.called).__doc__ or ""
    m = re.search(r":return: (\w+)List\b", doc)
    assert m, f"{kind}: 반환 타입을 찾지 못함"
    return m.group(1)


def _typed(obj: dict, model: str):
    return k8s_client.ApiClient()._ApiClient__deserialize(copy.deepcopy(obj), model)


def _norm(rows):
    out = []
    for r in rows:
        d = r.model_dump()
        d["age_seconds"] = d["age_seconds"] // 10 if d["age_seconds"] is not None else None
        out.append(d)
    return out


@pytest.mark.parametrize("kind", sorted(kr.KIND_MAP))
def test_rows_match_typed_models(kind):
    typed_rows = kr._build_rows(kind, [_typed(SAMPLE, _item_model(kind))])
    raw_rows = kr._build_rows(kind, [K8sObj(copy.deepcopy(SAMPLE))])
    assert _norm(raw_rows) == _norm(typed_rows)
    # 컬럼이 정의된 종류는 실제로 값이 채워졌는지(둘 다 빈 dict 로 같아지는 것 방지)
    if kind in kr.RESOURCE_COLUMNS:
        assert raw_rows[0].cols, kind


def test_adapter_semantics():
    o = K8sObj(copy.deepcopy(SAMPLE))
    assert o.spec.cluster_ip == "10.0.0.1"                     # clusterIP (약어 키)
    assert o.spec.external_i_ps == ["5.6.7.8"]                 # externalIPs
    assert o.status.last_schedule_time.year == 2024            # datetime 파싱
    assert o.metadata.creation_timestamp.tzinfo is not None
    assert o.spec.does_not_exist is None                       # 없는 필드 → None
    assert (o.status.capacity or {}).get("storage") == "10Gi"  # dict 형 필드
    assert len(o.data) == 2 and "a" in o.data
    assert bool(K8sObj({})) is True                            # typed 객체처럼 항상 truthy
    lst = K8sObj({"metadata": {"continue": "tok", "remainingItemCount": 9}, "items": [{"a": 1}]})
    assert lst.metadata._continue == "tok" and lst.metadata.remaining_item_count == 9


def test_raw_call_passes_timeout_and_no_preload():
    seen = {}

    class _Resp:
        data = b'{"items": [], "metadata": {}}'

        def release_conn(self):
            seen["released"] = True

    def fn(*a, **kw):
        seen.update(kw)
        return _Resp()

    out = raw_call(fn, "ns", limit=5, timeout=(1, 2))
    assert seen["_preload_content"] is False and seen["_request_timeout"] == (1, 2)
    assert seen["limit"] == 5 and seen["released"] is True
    assert out.items == []


def test_pods_and_nodes_rich_rows_match(monkeypatch):
    pod_list = {"metadata": {}, "items": [copy.deepcopy(SAMPLE)]}
    ev_list = {"metadata": {}, "items": [
        {"metadata": {"name": "e1"}, "involvedObject": {"kind": "Pod", "name": "obj-1", "namespace": "ns-a"},
         "reason": "BackOff", "type": "Warning", "lastTimestamp": TS},
        {"metadata": {"name": "e2"}, "involvedObject": {"kind": "Pod", "name": "obj-1", "namespace": "ns-a"},
         "reason": "Unhealthy", "type": "Warning", "lastTimestamp": "2024-01-02T03:09:05Z"},
    ]}

    class _Resp:
        def __init__(self, body):
            import json
            self.data = json.dumps(body).encode()

        def release_conn(self):
            pass

    def make(raw: bool):
        class V1:
            def __init__(self, _c):
                pass

            def _ret(self, body, model, kw):
                if kw.get("_preload_content") is False:
                    return _Resp(body)
                return _typed(body, model)

            def list_pod_for_all_namespaces(self, **kw):
                return self._ret(pod_list, "V1PodList", kw)

            def list_event_for_all_namespaces(self, **kw):
                return self._ret(ev_list, "CoreV1EventList", kw)

            def list_node(self, **kw):
                return self._ret(pod_list, "V1NodeList", kw)
        return V1

    class CO:
        def __init__(self, _c):
            pass

        def list_cluster_custom_object(self, *a, **kw):
            return {"items": [{"metadata": {"name": "obj-1", "namespace": "ns-a"},
                               "usage": {"cpu": "250m", "memory": "128Mi"},
                               "containers": [{"usage": {"cpu": "250m", "memory": "128Mi"}}]}]}

    monkeypatch.setattr(kr.k8s_client, "CustomObjectsApi", CO)
    monkeypatch.setattr(kr.k8s_client, "CoreV1Api", make(True))
    pods_raw = kr._load_pods_rich(object(), None)
    nodes_raw = kr._load_nodes_rich(object())

    # typed 기준값: raw_call 을 typed 로 우회
    monkeypatch.setattr(kr, "raw_call", lambda fn, *a, timeout=None, **kw: fn(*a, _request_timeout=timeout, **kw))
    pods_typed = kr._load_pods_rich(object(), None)
    nodes_typed = kr._load_nodes_rich(object())

    def dump(body):
        return {**body, "items": _norm(body["items"])}

    assert dump(pods_raw) == dump(pods_typed)
    assert dump(nodes_raw) == dump(nodes_typed)
    row = pods_raw["items"][0]
    assert row.warning_count == 2 and row.warning_reason == "Unhealthy"
    assert row.status_color == "red" and row.restarts == 7
