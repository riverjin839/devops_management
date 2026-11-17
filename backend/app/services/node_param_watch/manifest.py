"""노드 파라미터 에이전트 설치 매니페스트 렌더링 — 화면의 "에이전트 설치" 카드가 그대로 보여준다.

저장소의 ``deploy/k8s/node-param-agent/`` 와 같은 내용을 클러스터 UUID·이미지·주소를 채워서 만든다
(GitOps 로 배포하면 저장소 쪽을, 바로 붙여 넣어 쓰면 이 렌더 결과를 쓴다). 토큰은 넣지 않는다 —
화면에 비밀값이 뜨지 않도록 자리표시자만 두고 운영자가 채운다.

보안 설계(권한 최소화):
- 특권(privileged)·hostPID 없음, 모든 capability 제거, 비 root(65534), 루트 파일시스템 읽기 전용.
- ``hostNetwork``·``hostIPC`` 는 **값을 바르게 읽기 위해** 켠다 — ``net.*`` 는 네트워크 네임스페이스별,
  ``kernel.shm*``/``kernel.msg*`` 는 IPC 네임스페이스별 값이라 파드 자신의 값을 읽게 되기 때문.
- 호스트 경로는 sysctl 설정 파일 위치만 읽기 전용으로 마운트한다(``/etc`` 전체를 마운트하지 않는다).
- 쿠버네티스 API 를 쓰지 않으므로 서비스어카운트 토큰을 마운트하지 않는다.
"""
from __future__ import annotations

import json

AGENT_NAME = "node-param-agent"
SECRET_NAME = "node-param-agent-config"
TOKEN_PLACEHOLDER = "REPLACE-WITH-NODE_PARAM_INGEST_TOKEN"


def _q(value: str) -> str:
    """YAML 안전 문자열(JSON 문자열은 유효한 YAML 스칼라다)."""
    return json.dumps(value, ensure_ascii=False)


def render_manifest(*, cluster_id: str, cluster_name: str, api_base_url: str, image: str,
                    namespace: str, tls_verify: bool) -> str:
    ns = _q(namespace)
    return f"""# PEP 노드 OS 파라미터 에이전트 — 클러스터: {cluster_name}
# 1) 아래 Secret 의 NODE_PARAM_INGEST_TOKEN 을 PEP backend 의 NODE_PARAM_INGEST_TOKEN 값으로 바꾼다.
# 2) kubectl apply -f <이 파일>
# 3) PEP ▸ K8s 허브 ▸ 점검 ▸ OS 파라미터 감시 에서 노드가 '보고 중' 으로 바뀌는지 확인한다.
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
  NODE_PARAM_INGEST_TOKEN: {_q(TOKEN_PLACEHOLDER)}
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
      hostNetwork: true
      hostIPC: true
      dnsPolicy: ClusterFirstWithHostNet
      tolerations:
        - operator: Exists
      securityContext:
        runAsNonRoot: true
        runAsUser: 65534
        runAsGroup: 65534
        seccompProfile:
          type: RuntimeDefault
      containers:
        - name: agent
          image: {_q(image)}
          imagePullPolicy: IfNotPresent
          command: ["python", "-m", "app.node_param_agent"]
          env:
            - name: NODE_NAME
              valueFrom:
                fieldRef:
                  fieldPath: spec.nodeName
            - name: HOST_IP
              valueFrom:
                fieldRef:
                  fieldPath: status.hostIP
            - name: HOST_ROOT
              value: /host
            - name: PYTHONDONTWRITEBYTECODE
              value: "1"
          envFrom:
            - secretRef:
                name: {SECRET_NAME}
          securityContext:
            allowPrivilegeEscalation: false
            readOnlyRootFilesystem: true
            capabilities:
              drop: ["ALL"]
          resources:
            requests:
              cpu: 10m
              memory: 48Mi
            limits:
              cpu: 100m
              memory: 128Mi
          volumeMounts:
            - name: etc-sysctl-conf
              mountPath: /host/etc/sysctl.conf
              readOnly: true
            - name: etc-sysctl-d
              mountPath: /host/etc/sysctl.d
              readOnly: true
            - name: run-sysctl-d
              mountPath: /host/run/sysctl.d
              readOnly: true
            - name: usr-lib-sysctl-d
              mountPath: /host/usr/lib/sysctl.d
              readOnly: true
      volumes:
        - name: etc-sysctl-conf
          hostPath:
            path: /etc/sysctl.conf
            type: FileOrCreate
        - name: etc-sysctl-d
          hostPath:
            path: /etc/sysctl.d
            type: DirectoryOrCreate
        - name: run-sysctl-d
          hostPath:
            path: /run/sysctl.d
            type: DirectoryOrCreate
        - name: usr-lib-sysctl-d
          hostPath:
            path: /usr/lib/sysctl.d
            type: DirectoryOrCreate
"""
