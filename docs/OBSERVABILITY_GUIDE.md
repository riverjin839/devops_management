# Observability 가이드 — 관측 스택 대시보드 · 인시던트 알람 수신

PEP 의 관측/알람 기능은 두 화면으로 나뉜다.

| 화면 | 방향 | 하는 일 |
|---|---|---|
| **`/observability`** | PEP → 클러스터 (**조회**) | 관측 스택(kube-prometheus-stack 등)의 개별 지표·규칙·타겟·발화중 알람을 dense 테이블로 훑는다 |
| **`/alerts`** | 클러스터 → PEP (**수신**) | Alertmanager / 사내 alert-forwarder 가 밀어넣은 인시던트 알람을 쌓아두고 담당자에게 알린다 |

둘은 독립적이라 한쪽만 켜도 된다.

---

## 1. `/observability` — 지표 대시보드

### 1-1. 클러스터 설정

**클러스터 관리 → 정보 수정 → 모니터링 연동** 에서 클러스터마다 켠다.

| 항목 | 설명 |
|---|---|
| Observability 대시보드 사용 | 꺼져 있으면 화면이 "미연결"로만 뜬다. **켜야 조회한다.** |
| Prometheus URL | 비우면 전역 `PROMETHEUS_URL`. (클러스터 추이와 같은 값을 공유한다) |
| Alertmanager URL | 비우면 전역 `ALERTMANAGER_URL` |
| 수집 모드 | `pull` = PEP 가 직접 조회 / `push` = in-cluster 수집기가 스냅샷 전송 |

### 1-2. 수집 모드 — pull vs push

**pull (기본)** — PEP 백엔드에서 클러스터의 Prometheus·Alertmanager 로 HTTP 가 통하는 환경.
설정만 하면 끝이고, 화면에 `실시간` 배지가 뜬다.

**push** — 폐쇄망/네트워크 분리로 PEP 에서 클러스터에 닿지 않는 환경. 클러스터 안에서 수집기가
주기적으로 긁어 PEP 로 밀어넣고, 화면은 `스냅샷 · n분 전` 배지로 신선도를 보여준다.

```bash
# 1) 수집기가 쓸 토큰 시크릿 생성 (PEP 의 ALERT_INGEST_TOKEN 과 같은 값)
kubectl -n monitoring create secret generic pep-ingest \
  --from-literal=token=<ALERT_INGEST_TOKEN>

# 2) 매니페스트의 PEP_URL / 네임스페이스 / 서비스명을 환경에 맞게 고친 뒤 적용
kubectl apply -f k8s/base/observability/pep-collector-cronjob.yaml
```

수집기는 5분마다 아래를 PEP 로 POST 한다 (`kind` 별로 1건씩):

| kind | 소스 |
|---|---|
| `metrics` | 지표 카탈로그의 PromQL 을 `/api/v1/query` 로 실행한 결과 `{key: {value, labels}}` |
| `rules` | `/api/v1/rules` 원본 |
| `targets` | `/api/v1/targets?state=active` 원본 |
| `alerts` | `/api/v1/alerts` 원본 |

`POST /api/v1/observability/snapshot/ingest` 는 같은 (클러스터, 모듈, kind) 의 최신 5건만
남기고 오래된 스냅샷을 정리한다.

### 1-3. 지표 카탈로그는 코드가 아니라 DB 행이다

CLAUDE.md §UI-First 원칙에 따라 **지표 목록·PromQL·임계값·표시형식이 전부 DB 행**이다
(`observability_modules` / `observability_metrics`). 최초 부팅 시
`services/observability/catalog_seed.py` 의 기본값이 seed 되고, 그 뒤로는 화면에서 편집한 값이
원천이다 (seed 는 테이블이 비었을 때만 동작하므로 편집한 값을 덮어쓰지 않는다).

**기본 지표가 안 맞으면 화면에서 고친다.** 특히 job 라벨은 배포마다 다르다:

```promql
# 기본값 (정규식으로 넓게 잡아둔 상태)
min(up{job=~".*prometheus.*"})

# 헬름 릴리스명이 다르면 예컨대 이렇게
min(up{job="kube-prometheus-stack-prometheus"})
```

지표 필드:

| 필드 | 의미 |
|---|---|
| `키` | 모듈 안에서 고유한 슬러그. push 모드 스냅샷의 키와 일치해야 한다 |
| `PromQL` | 이 지표의 표현식. 결과 시리즈가 여러 개면 **가장 나쁜 값**을 대표로 표시 |
| `임계값` | `warning:70,critical:90` 형식. 비우면 항상 정상으로 보이는 정보성 지표 |
| `값이 낮을수록 나쁨` | `up` 처럼 0 이 장애인 지표에 체크 (`critical:1` + 체크 → 1 미만이 심각) |
| `표시 형식` | 숫자 / 가동여부 / 비율(%) / 바이트 / 시간(초) — 단위 환산에 쓰인다 |
| `설명` | 운영자가 화면에서 읽는 도움말. 무엇을 의심해야 하는지 적어둔다 |

### 1-4. 모듈 추가 (alert-forwarder / opensearch-stack / fluent-operator)

세 모듈은 탭에 "준비중"으로 자리만 잡혀 있다. **지표를 1개라도 추가하면 자동으로 활성화**된다 —
백엔드 코드를 고칠 필요가 없다.

- 화면: `/observability` → 모듈 탭에서 대상 모듈 선택 불가 상태이므로, 먼저
  `POST /api/v1/observability/metrics` 로 `module_key` 를 지정해 1건 추가하거나,
  `catalog_seed.py` 의 `METRICS` 에 기본값을 넣어 배포한다.
- 예: fluent-operator 라면 `fluentbit_output_retries_failed_total`,
  `fluentbit_input_records_total` 같은 지표를 등록한다.

`지표 / 알람 규칙 / 스크레이프 타겟 / 발화중 알람` 4개 뷰 중 뒤의 3개는 Prometheus HTTP API 를
직접 읽으므로 `kube-prometheus-stack` 모듈에서만 열린다. 다른 모듈은 `지표` 뷰만 쓴다.

---

## 2. `/alerts` — 인시던트 알람 수신

### 2-1. 토큰 설정 (필수, fail-closed)

```bash
# backend/.env
ALERT_INGEST_TOKEN=$(python3 -c "import secrets; print(secrets.token_urlsafe(32))")
```

**미설정이면 수신 엔드포인트가 503 으로 닫혀 있다.** 알람 수신구는 사내망에 열리는
엔드포인트라 "설정을 깜빡했다"가 곧 무인증 공개가 되면 안 되기 때문이다
(`KUBEWATCH_TOKEN` / `SUPERPOD_INGEST_TOKEN` 과 같은 정책).

### 2-2. Alertmanager receiver 등록 (권장 경로)

기존 cube receiver 를 그대로 두고 PEP 를 **추가**한다. `continue: true` 가 핵심이다 —
이게 없으면 첫 매칭 route 에서 멈춰 cube 로 안 간다.

```yaml
receivers:
  - name: cube            # (기존) 사내 메신저
    webhook_configs:
      - url: http://alert-forwarder.observability.svc:8080/cube

  - name: pep             # (추가) PEP 알람 인박스
    webhook_configs:
      - url: https://<PEP-HOST>/api/v1/observability/alerts/ingest
        send_resolved: true          # 해소 알림도 보내야 인박스가 resolved 로 닫힌다
        http_config:
          authorization:
            type: Bearer
            credentials: <ALERT_INGEST_TOKEN>

route:
  receiver: cube
  routes:
    - receiver: pep
      continue: true                 # cube 로도 계속 보낸다(둘 다 수신)
      group_wait: 30s
      group_interval: 5m
      repeat_interval: 4h
```

같은 내용을 화면에서도 복사할 수 있다 — `/alerts` 상단의 **"알람 수신 설정 방법"** 을 펼친다.

### 2-3. alert-forwarder 경유 (대안)

Alertmanager 설정을 못 건드리는 상황이면 사내 `alert-forwarder` 가 cube 와 함께 PEP 로도
쏘게 하면 된다. **같은 엔드포인트가 Alertmanager 표준 포맷이 아닌 임의 JSON 도 받는다.**

```json
{ "title": "NodeDiskPressure", "level": "P1", "message": "노드 디스크 92%",
  "host": "worker-03", "cluster": "prod-b", "timestamp": 1785000000 }
```

generic 파서(`services/observability/alert_ingest.py`)가 흔한 키 별칭을 매핑한다:

| 필드 | 인식하는 키 |
|---|---|
| 알람명 | `alertname` `alert_name` `name` `title` `subject` `rule` `check` |
| 요약 / 설명 | `summary` `title` `message` `text` / `description` `detail` `body` |
| 심각도 | `severity` `priority` `level` `urgency` — `P1`/`fatal`/`error`/`high` → critical, `warn`/`major`/`minor` → warning, `low`/`P3` → info |
| 대상 | `pod` `instance` `node` `host` `hostname` `resource` `target` `service` |
| 해소 여부 | `status`/`state` 가 `resolved` `ok` `recovered` `cleared` `closed` 중 하나면 해소 |

`fingerprint` 가 없으면 정렬된 라벨셋의 sha1 로 만든다 — 같은 알람이면 같은 값이 나오므로
중복 억제가 정상 동작한다.

### 2-4. 클러스터 매칭

수신한 알람이 어느 클러스터 것인지 아래 순서로 찾는다. 못 찾으면 클러스터 없이 저장된다
(인박스에서 "전체"로 보인다) — **수신 자체는 실패하지 않는다.**

1. 쿼리 파라미터 `?cluster=<이름 또는 UUID>`
2. 라벨 `cluster`
3. 라벨 `prometheus`

클러스터마다 receiver URL 뒤에 `?cluster=prod-a` 를 붙여두는 게 가장 확실하다.

### 2-5. 수신 확인

```bash
curl -sS -X POST 'https://<PEP-HOST>/api/v1/observability/alerts/ingest?cluster=prod-a' \
  -H "Authorization: Bearer $ALERT_INGEST_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"version":"4","status":"firing","alerts":[{"status":"firing",
       "labels":{"alertname":"PepIngestTest","severity":"warning"},
       "annotations":{"summary":"PEP 알람 수신 테스트"},
       "startsAt":"2026-07-28T00:00:00Z"}]}'
```

| 응답 | 의미 |
|---|---|
| `201` | 정상 — `/alerts` 에 행이 생긴다 |
| `401` | 토큰 불일치 |
| `503` | `ALERT_INGEST_TOKEN` 미설정 (fail-closed) |
| `422` | 알람을 추출할 수 없는 페이로드 |

---

## 3. 알림 라우팅 · 중복 억제

`/alerts` → **알림 규칙** 탭에서 전부 화면으로 관리한다.

### 3-1. 평가 순서

1. 규칙을 **순위(priority) 오름차순**으로 평가해 **첫 매칭 1건**만 적용한다.
2. 매칭되는 규칙이 없으면 **전역 기본값**을 쓴다.

### 3-2. 매처

| 매처 | 비고 |
|---|---|
| 클러스터 | 비우면 전체 |
| **모듈/서비스 패턴** | 정규식 부분 매칭. 알람 라벨 중 `module` → `job` → `service` → `component` → `app` → `app_kubernetes_io_name` 순으로 **처음 존재하는 값**에 적용한다. 실무에선 대개 `job` 이 모듈을 알려준다(`fluent-bit`, `opensearch`, `kube-prometheus-stack-prometheus` …). 후보 라벨이 하나도 없으면 **미매칭** |
| 알람명 패턴 | 정규식 부분 매칭 (`^Etcd\|^KubeAPI`). 깨진 정규식은 부분 문자열 매칭으로 폴백 |
| 네임스페이스 패턴 | 정규식 부분 매칭 |
| 라벨 조건 | `team=platform, tier=prod` — 모두 일치해야 함(AND) |
| 최소 심각도 | 이 이상만 이 규칙에 걸린다 |

> "운영 모듈별 담당자 매핑"은 이 매처 조합 + 담당자 목록으로 표현한다.
> 예) `모듈/서비스 패턴 = fluent` + `담당자 = 김철수, 이영희` → fluent-bit/fluentd 알람은
> 두 사람에게만. 알람명 기준이 더 정확하면 `알람명 패턴 = ^Etcd` 를 쓴다.

> ⚠️ 과거 버전에서는 모듈 조건이 `module` 라벨 하나만 봐서 **어떤 알람에도 매칭되지 않았다**.
> 그 시절에 만들어 둔 규칙이 있다면 지금 값 그대로 정상 동작하는지 다시 확인한다.

### 3-3. 알림 대상

| 모드 | 동작 |
|---|---|
| **전체** | 활성 사용자 전원에게 개인 알림 행을 만든다(팬아웃). 읽음 처리가 개인별로 동작한다 |
| **담당자** | 규칙의 담당자 목록에만. `username` 또는 표시 이름 아무거나 |
| **알림 없음** | 종 배지를 건드리지 않고 `/alerts` 인박스에만 쌓는다 |

**재전파 채널 (선택)** — 규칙에 걸린 알람을 기존 알림 채널(Slack / webhook / email)로도 보낼 수
있다. 규칙 편집기의 "재전파 채널"에서 체크박스로 고르며, 채널 자체의 등록·수정은
**점검 항목 관리 → 알림 채널**에서 한다. 중복 억제 창 안에서 억제된 반복 알람은 재전파도
하지 않는다(알림을 새로 만들 때만 함께 나간다).

### 3-4. 중복 억제 — "5분에 10건 오면 알림 1번"

같은 알람(fingerprint)이 **억제 창** 안에서 반복 수신될 때:

| 모드 | 동작 |
|---|---|
| **요약** (기본) | 개인 알림을 새로 만들지 않고 **기존 알림 문구를 "최근 5분간 10회"로 갱신**한다 |
| **최초 1회** | 개인 알림 없이 억제 카운트만 올린다 |

어느 쪽이든 인박스 행은 **하나**이고 `반복 ×10 (억제 9)` 로 표시된다. 창이 지난 뒤 다시 오면
새 알림 1건을 만들고 카운터를 리셋한다.

### 3-5. 심각도 재정의

수신 페이로드의 severity 를 규칙이 덮어쓸 수 있다. 예) 사내 forwarder 가 모든 알람을
`warning` 으로 보내는데 etcd 계열만 critical 로 취급하고 싶을 때. 재정의된 행은 인박스에
`(규칙)` 표시가 붙는다.

### 3-6. 전역 기본값

| 항목 | 기본 |
|---|---|
| 알림 대상 | 전체 |
| 알림 최소 심각도 | warning (info 는 인박스에만 쌓인다) |
| 중복 억제 창 | 300초 (5분) |
| 중복 처리 | 요약 |
| 알람 보존 | 90일 (`log_retention_service` 가 매일 03:20 정리) |

---

## 4. 트러블슈팅

| 증상 | 확인할 것 |
|---|---|
| `/observability` 가 계속 "미연결" | 클러스터 정보 수정에서 **Observability 사용**이 켜져 있는지. Prometheus URL 이 백엔드 파드에서 도달 가능한지 |
| 지표가 전부 "오류" | job 라벨 불일치가 가장 흔하다. 지표 편집에서 PromQL 의 `job=~"..."` 를 실제 값으로 |
| 규칙/타겟 탭이 비어 있음 | Prometheus HTTP API(`/api/v1/rules`)가 열려 있는지. push 모드면 수집기가 `rules`/`targets` 스냅샷을 보내는지 |
| 알람 수신 503 | `ALERT_INGEST_TOKEN` 미설정 |
| 알람은 쌓이는데 종 배지가 안 뜸 | 알림 규칙의 대상이 **알림 없음**이거나, 최소 심각도보다 낮거나, 중복 억제 창 안 |
| 알람이 클러스터 없이 들어옴 | receiver URL 에 `?cluster=<이름>` 을 붙이거나 알람 라벨에 `cluster` 를 추가 |
| resolved 로 안 닫힘 | Alertmanager receiver 에 `send_resolved: true` 가 있는지 |

관련 코드: `backend/app/routers/observability.py`,
`backend/app/services/observability/{alert_ingest,alert_router,catalog_seed}.py`,
`backend/app/services/alertmanager_service.py`,
`frontend/src/pages/{ObservabilityPage,AlertInboxPage}.tsx`.
화면 명세는 `docs/SCREENS.md`, 환경변수는 `docs/ENVIRONMENT.md`.
