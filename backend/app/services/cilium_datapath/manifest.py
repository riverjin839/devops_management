"""pep-bpf-agent 설치 매니페스트 렌더링 — 화면의 「에이전트 설치」 가 그대로 보여준다.

저장소의 ``deploy/k8s/cilium-bpf-agent/daemonset.yaml`` 과 같은 DaemonSet 을 클러스터 UUID·이미지·주소를 채워
만든다(GitOps 면 저장소 쪽, 바로 붙여 넣으면 이 렌더 결과). 토큰은 넣지 않는다 — 화면에 비밀값이 뜨지 않게
자리표시자만 둔다.

권한 최소화:
- 특권(privileged)·hostPID·hostNetwork 없음. 서비스어카운트 토큰 미마운트(쿠버네티스 API 를 쓰지 않는다).
- capability 는 전부 제거하고 ``BPF`` 하나만 더한다(고정 맵을 읽기 전용으로 여는 데 필요).
  설정 「CAP_SYS_ADMIN 부여」 를 켜면 ``SYS_ADMIN`` 이 더해진다 — 프로그램 목록·고정되지 않은 맵 조회,
  CAP_BPF 가 없는 5.8 미만 커널에서만 필요하다.
- ``/sys/fs/bpf`` 만 읽기 전용으로 마운트한다. Cilium 의 고정 파일은 root 소유 0600 이라 uid 0 으로 돈다
  (DAC_OVERRIDE 등 다른 capability 는 없다). 루트 파일시스템 읽기 전용.
"""
from __future__ import annotations

import json

AGENT_NAME = "cilium-bpf-agent"
SECRET_NAME = "cilium-bpf-agent-config"
TOKEN_PLACEHOLDER = "REPLACE-WITH-CILIUM_BPF_AGENT_TOKEN"


def _q(value: str) -> str:
    """YAML 안전 문자열(JSON 문자열은 유효한 YAML 스칼라다)."""
    return json.dumps(value, ensure_ascii=False)


def render_manifest(*, cluster_id: str, cluster_name: str, api_base_url: str, image: str,
                    namespace: str, tls_verify: bool, sys_admin: bool = False) -> str:
    ns = _q(namespace)
    caps = '["BPF", "SYS_ADMIN"]' if sys_admin else '["BPF"]'
    return f"""# PEP Cilium 데이터패스 에이전트(pep-bpf-agent) — 클러스터: {cluster_name}
# 1) 아래 Secret 의 CILIUM_BPF_AGENT_TOKEN 을 PEP backend 의 CILIUM_BPF_AGENT_TOKEN 값으로 바꾼다.
# 2) kubectl apply -f <이 파일>
# 3) PEP ▸ K8s 허브 ▸ 진단 ▸ Cilium 데이터패스 에서 노드가 '보고 중' 으로 바뀌는지 확인한다.
apiVersion: v1
kind: Namespace
metadata:
  name: {ns}
---
apiVersion: v1
kind: Secret
metadata:
  name: {SECRET_NAME}
  namespace: {ns}
type: Opaque
stringData:
  PEP_API_URL: {_q(api_base_url)}
  PEP_CLUSTER: {_q(cluster_id)}
  CILIUM_BPF_AGENT_TOKEN: {_q(TOKEN_PLACEHOLDER)}
  PEP_TLS_VERIFY: {_q("true" if tls_verify else "false")}
---
apiVersion: apps/v1
kind: DaemonSet
metadata:
  name: {AGENT_NAME}
  namespace: {ns}
  labels:
    app.kubernetes.io/name: {AGENT_NAME}
    app.kubernetes.io/part-of: k8s-daily-monitor
spec:
  selector:
    matchLabels:
      app.kubernetes.io/name: {AGENT_NAME}
  updateStrategy:
    type: RollingUpdate
  template:
    metadata:
      labels:
        app.kubernetes.io/name: {AGENT_NAME}
    spec:
      automountServiceAccountToken: false
      tolerations:
        - operator: Exists
      securityContext:
        runAsUser: 0
        runAsGroup: 0
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: {_q(image)}
          imagePullPolicy: IfNotPresent
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: HOST_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
          envFrom:
            - secretRef:
                name: {SECRET_NAME}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
              add: {caps}
          resources:
            requests:
              cpu: 10m
              memory: 16Mi
            limits:
              cpu: 200m
              memory: 64Mi
          volumeMounts:
            - name: bpffs
              mountPath: /sys/fs/bpf
              mountPropagation: HostToContainer
              readOnly: true
      volumes:
        - name: bpffs
          hostPath:
            path: /sys/fs/bpf
            type: Directory
"""
