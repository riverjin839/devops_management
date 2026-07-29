# 네트워크 옵저버빌리티 수집 스택 (`k8s/base/observability`)

대규모(200+ 노드) 데이터레이크 환경의 **네트워크 계층 관측**을 위한 수집기 묶음. 장비(라우터/스위치)는
클러스터 밖에 있고, 여기 배포되는 것은 **수집기(collector)** 다. 모든 지표는 단일 Prometheus 로 모인다.

| 컴포넌트 | 프로토콜 | 포트(검증) | 노출 | 역할 |
|---|---|---|---|---|
| `telegraf-snmp` | SNMP v2c 폴링 | 장비 UDP **161** | `/metrics` **:9273** | ifHCIn/OutOctets, ifIn/OutErrors, ifOperStatus 등 |
| `gnmic` | gNMI / OpenConfig(YANG) | 장비 gRPC **57400** | `/metrics` **:9804** | 인터페이스 카운터·BGP neighbor state 스트리밍(push) |
| `openbmp-collector` | BMP (RFC 7854) | collector TCP **5000** | Kafka **9092** | BGP peer up/down·route monitoring·**withdraw** |

> 포트 주: 161/162(SNMP), 5000(OpenBMP 기본), 862(TWAMP-Control, RFC 5357), 9092(Kafka) 는 표준/사실상
> 기본값. gNMI 57400 은 IOS-XR/EOS/SR OS 등에서 흔한 기본이나 **장비 설정 의존**이므로 확인 후 사용.

## 배포
```bash
kubectl apply -k k8s/base/observability/

# 시크릿(권장) — 평문 community/계정 대신
kubectl -n network-observability create secret generic telegraf-snmp-secret --from-literal=community=<RO_COMMUNITY>
kubectl -n network-observability create secret generic gnmic-secret --from-literal=username=<U> --from-literal=password=<P>
```
- `telegraf-snmp.yaml` 의 `SNMP_AGENTS`(콤마 구분), `gnmic-config` 의 `targets` 를 실제 장비로 채운다.
- `openbmp-collector` 이미지는 **사내 레지스트리 미러의 검증 태그로 교체**(자리표시값임). Kafka 가 없으면
  데이터레이크의 기존 Kafka 로 `KAFKA_FQDN` 지정.

## Prometheus 연동
- **이 레포의 plain Prometheus**: `k8s/base/monitoring/prometheus-configmap.yaml` 에 `telegraf-snmp`/`gnmic`
  스크랩 job 을 추가해 두었다(cross-namespace FQDN). 
- **운영 kube-prometheus-stack(operator)**: `k8s/base/monitoring/network-quality-servicemonitor.yaml` 의
  ServiceMonitor 가 `component: observability` 라벨을 셀렉트한다.

## PEP Observability 수집기 (`pep-collector-cronjob.yaml`)

위 3개 수집기와는 목적이 다르다 — **PEP 화면(`/observability`)에 지표를 공급하는 push 모드
수집기**다. PEP 백엔드에서 이 클러스터의 Prometheus 로 HTTP 가 닿지 않을 때만 쓴다
(닿으면 클러스터 설정을 `pull` 로 두고 이 CronJob 은 배포하지 않는다).

```bash
kubectl -n monitoring create secret generic pep-ingest --from-literal=token=<ALERT_INGEST_TOKEN>
# 매니페스트의 PEP_URL / CLUSTER_NAME / PROM_URL / AM_URL 을 환경에 맞게 고친 뒤
kubectl apply -f k8s/base/observability/pep-collector-cronjob.yaml
```

5분마다 `rules` / `targets` / `alerts` / `metrics` 스냅샷을
`POST /api/v1/observability/snapshot/ingest` 로 보낸다. 환경 의존값이 많아 `kustomization.yaml`
에는 넣지 않았다. 상세는 `docs/OBSERVABILITY_GUIDE.md` §1-2.

## 장비 측 설정(요약)
- SNMP: RO 커뮤니티 + ACL 로 collector IP 만 허용.
- gNMI: `grpc`/`telemetry` 활성 + 구독 경로(OpenConfig) 권한 계정.
- BMP: `bmp server <collector-svc-ext-ip> port 5000` (adj-rib-in pre/post-policy).
