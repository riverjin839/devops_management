# Coroot 연동 가이드 — 애플리케이션 APM 계층

PEP 는 이미 **Hubble/Cilium 기반 네트워크 관측**(패킷 흐름·flow·정책)을 제공한다.
이 가이드는 그 위에 **애플리케이션 레벨 APM**(서비스 지연·에러율·SLO·trace 진입점)을
[coroot](https://github.com/coroot/coroot) 연동으로 추가하는 방법을 설명한다.

> 설계 원칙: **coroot 소스는 PEP repo 에 포함하지 않는다.** coroot 은 외부에 별도 배포하고,
> PEP 는 헬스/요약/딥링크만 얇게 연동한다. coroot 미배포 환경에서도 PEP 는 정상 동작하며
> 해당 메뉴만 "offline" 으로 빠진다 (Prometheus/Ollama 와 동일한 fail-safe 패턴).

---

## 1. coroot 별도 설치 (인프라 / admin)

coroot 은 두 덩어리로 구성된다.

### (a) coroot 본체 + 저장소 — 한 곳에 설치
보통 PEP 가 도는 클러스터(또는 별도 관측용 네임스페이스)에 Helm 으로 1회 설치한다.

```bash
helm repo add coroot https://coroot.github.io/helm-charts
helm repo update
helm install coroot coroot/coroot -n coroot --create-namespace
```

- **ClickHouse** (trace/log 저장) 용 PVC(디스크)를 충분히 확보한다.
- coroot UI 를 Ingress 또는 NodePort 로 노출한다 → 이 주소가 `COROOT_URL` 이 된다.

### (b) coroot-node-agent (eBPF 수집기) — 관측 대상 클러스터마다
trace/metric 을 실제로 수집하는 **DaemonSet**. 모니터링하려는 **클러스터마다** 설치하고,
수집 데이터를 (a) 의 coroot 서버로 전송하도록 설정한다.

- privileged + hostPID 권한 필요 (eBPF).
- 노드 리소스를 소비하므로 **관측이 꼭 필요한 클러스터에만** 설치하는 것을 권장.

### 폐쇄망(airgap)
coroot / ClickHouse / node-agent 이미지를 사내 레지스트리에 미러링한 뒤 values 로 주소를 덮어쓴다.

---

## 2. PEP 연동 설정 (admin)

### (a) 전역 base URL — 환경변수
백엔드 `.env` (또는 배포 환경변수)에 coroot UI 주소를 설정한다.

```bash
COROOT_URL=http://coroot.coroot.svc:8080
# COROOT_API_KEY=...     # coroot 가 API 키 인증을 쓰는 경우(선택)
# COROOT_TIMEOUT=10
```

비워두면 APM 기능 전체가 offline 으로 비활성화된다.

### (b) per-cluster project 매핑 — 클러스터 관리 화면
coroot 은 보통 1개 배포가 여러 project(=클러스터)를 담당한다.
**클러스터 관리 → 정보 수정 → 기타(extra) 탭 → "애플리케이션 APM (Coroot)"** 에서:

| 필드 | 설명 |
|---|---|
| **coroot 연동 사용** | 이 클러스터에서 APM 메뉴 활성화 토글 (`coroot_enabled`) |
| **Coroot Project** | 이 클러스터에 대응하는 coroot project 이름 (`coroot_project`) |
| **Coroot URL** | 선택 — 전역 `COROOT_URL` 을 이 클러스터만 덮어쓸 때 (`coroot_url`) |

매핑이 없으면 해당 클러스터의 APM 페이지는 "연동/매핑 미설정" 안내로 빠진다.

---

## 3. 사용 — PEP 화면

좌측 사이드바 **서비스/앱 → 애플리케이션 APM** (`/coroot`):

- 좌측 ClusterSidebar(iconOnly)에서 클러스터 선택.
- 선택 클러스터의 coroot project 요약 카드(서비스 수 / 정상 / 알림).
- **"Open in Coroot"** 버튼으로 coroot UI 를 새 탭에서 연다 (서비스맵·trace·프로파일).
- (보조) **"여기에 임베드"** 로 coroot UI 를 iframe 으로 띄울 수 있다.

---

## 4. 동작 / 제약

- **fail-safe**: coroot 미설정·미배포·도달 불가 시 모든 엔드포인트가 500 대신
  `status: "offline"` 을 반환한다. PEP 의 나머지 기능은 영향받지 않는다.
- **iframe 임베드는 best-effort**: coroot 이 `X-Frame-Options`/CSP(`frame-ancestors`) 로
  임베드를 막으면 화면이 비어 보일 수 있다. 그 경우 "Open in Coroot" 딥링크를 사용한다.
  (딥링크가 1차 경로이므로 기능 손실은 없다.)
- **coroot API 버전차**: overview API 경로/필드는 coroot 버전마다 다를 수 있어, 요약 파싱은
  방어적으로 작성돼 있다(스키마가 달라도 죽지 않음). 배포된 버전에서 요약 수치가 비어 보이면
  딥링크로 coroot UI 를 직접 확인한다.

---

## 5. 관련 코드

| 영역 | 파일 |
|---|---|
| 백엔드 fail-safe 프록시 | `backend/app/services/coroot_service.py` |
| 백엔드 라우터 | `backend/app/routers/coroot.py` (`/api/v1/coroot/...`) |
| 설정 | `backend/app/config.py` (`coroot_url` / `coroot_api_key` / `coroot_timeout`) |
| per-cluster 컬럼 | `clusters.coroot_project` / `coroot_url` / `coroot_enabled` (`_run_migrations()`) |
| 프론트 페이지 | `frontend/src/pages/CorootApmPage.tsx` (route `/coroot`) |
| 프론트 API/훅 | `frontend/src/services/api.ts` (`corootApi`), `frontend/src/hooks/useCoroot.ts` |
| 클러스터 매핑 편집 | `frontend/src/pages/ClusterMetaFormPage.tsx` (extra 탭) |

### API 요약
| Method | Path | 설명 |
|---|---|---|
| GET | `/api/v1/coroot/health` | 전역 coroot 가용성 프로브 |
| GET | `/api/v1/coroot/{cluster_id}/summary` | 클러스터 project 의 application 요약 |
| GET | `/api/v1/coroot/{cluster_id}/deeplink` | 클러스터별 coroot UI 딥링크 |
| GET | `/api/v1/coroot/{cluster_id}/applications` | 서비스(application) 목록 — trace 드릴다운용 |
| GET | `/api/v1/coroot/{cluster_id}/application/deeplink?app_id=&view=` | 특정 서비스의 리포트(기본 `Tracing`) 딥링크 |

### 서비스별 trace 드릴다운
`/coroot` 페이지의 **"서비스 (trace 드릴다운)"** 카드는 coroot project 의 application
목록을 상태 점과 함께 보여준다. 각 행에서:
- **Trace** — 그 서비스의 분산 trace 뷰를 페이지에 임베드(best-effort).
- **↗(외부)** — coroot 에서 새 탭으로 trace 뷰를 연다.

app_id 는 coroot 의 `namespace:Kind:name` 형식이며, 딥링크는
`/p/{project}/app/{app_id}/{view}` (view: `Tracing`/`Logs`/`Profiling`) 로 구성된다.
