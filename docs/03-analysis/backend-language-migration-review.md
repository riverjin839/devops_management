# 백엔드 개발 언어 변경 검토 (Python → TypeScript)

**작성일**: 2026-08-10 · **상태**: 검토 완료 / 권고 = **변경하지 않음**

제기된 제안: "Python 타입 문제가 많으니 TypeScript 를 쓰자. 운영 경량화도 기대.
현재 대규모 K8s 환경에서 로깅이 무거워져 응답이 없다."

이 문서는 두 제기 사항(**타입 안전성**, **무응답/경량화**)을 이 저장소의 실제 코드로
검증하고, 언어 변경이 그 문제를 해결하는지 판정한다.

---

## 결론 요약

| 제기된 문제 | 실제 원인 | 언어 변경으로 해결되나 |
|---|---|---|
| 대규모 K8s 로깅 시 무응답 | **동시성 모델 오사용** — sync 스트리밍 핸들러가 스레드풀을 영구 점유 | ❌ 아니오. TS/Node 로 옮겨도 같은 구조면 **더 나빠진다** |
| Python 타입 문제 | **타입 체커를 한 번도 켠 적이 없음** (mypy/pyright 설정 부재, CI 검사 없음) | ❌ 아니오. `tsc` 를 안 돌리는 TS 와 동일한 상태 |
| 운영 경량화 | 메모리는 Node 가 유리하나, 현재 병목은 메모리가 아님 | △ 부분적. 그러나 원인과 무관 |

**권고**: 언어를 바꾸지 말고, 아래 1·2단계를 먼저 실행한다.
1단계로 무응답 문제가 해소되고, 2단계로 타입 안전성이 확보된다.
**투입 비용 차이는 약 1~2주 vs 6~12개월이다.**

---

## 1. 현황 실측

`2026-08-10` 기준, 이 저장소를 직접 계측한 값이다.

| 항목 | 값 |
|---|---|
| 백엔드 Python 파일 / 라인 | **402 개 / 81,547 줄** |
| ├ routers | 73 개 / 27,852 줄 (**HTTP 엔드포인트 529 개**, WebSocket 3 개) |
| ├ services | 141 개 / 28,599 줄 |
| ├ models | 60 개 / 3,830 줄 |
| ├ schemas | 46 개 / 4,723 줄 |
| └ tests | 68 개 / 11,958 줄 |
| 프론트엔드 TS/TSX | 484 개 / 109,135 줄 |
| Celery Beat 스케줄 | 11 개 엔트리 |
| 최근 3개월 변경된 백엔드 파일 | 410 개 (= 사실상 전 영역이 활발히 개발 중) |

즉 백엔드는 **8만 줄 규모이며 지금도 매주 바뀌고 있다.** 이 사실이 이후 판단의 전제다.

---

## 2. 문제 ①: "로깅이 무거워져 응답이 없다" — 원인 특정

### 2.1 근본 원인 — 스레드풀 고갈 (thread-pool starvation)

네 가지 사실이 겹쳐서 발생한다.

**(a) 라우트 핸들러의 89% 가 sync `def` 다.**

```
전체 라우트 핸들러 834 개 중  →  async def 90 개 (11%),  def 744 개 (89%)
```

FastAPI 는 `def` 로 선언된 핸들러를 **anyio 스레드풀**에서 실행한다.
이 풀의 기본 한도는 **40 스레드**이고, `backend/app/main.py` 어디에도 한도를
올리는 코드가 없다(`RunVar("_default_thread_limiter")` 조정 없음). 즉
**프로세스당 동시 처리 가능한 sync 요청은 40 개가 상한**이다.

**(b) 로그 스트리밍 핸들러가 그 스레드를 "영구히" 점유한다.**

`backend/app/routers/analyze.py:468` — 문제의 핵심:

```python
@router.get(".../pods/{pod_name}/logs/stream")
def stream_pod_logs(          # ← async 가 아니라 sync def
    ...,
    follow: bool = True,      # ← 기본값이 follow
):
    def _gen():               # ← sync generator
        resp = v1.read_namespaced_pod_log(..., follow=follow, _preload_content=False)
        for chunk in resp.stream(amt=None, decode_content=True):   # ← blocking 반복
            ...
    return StreamingResponse(_gen(), media_type="text/event-stream")
```

sync generator 를 `StreamingResponse` 에 넘기면 Starlette 은 매 `next()` 호출을
스레드풀로 위임한다. `follow=True` 인 tail 스트림은 **끝나지 않으므로**, 이 스트림
하나가 **브라우저 탭이 열려 있는 내내 스레드 1 개를 붙잡는다.** 타임아웃도, 동시
스트림 수 제한도 없다.

`stream_cluster_events`(`analyze.py:637`)도 동일한 구조다.

> **⇒ 로그 뷰어 탭 40 개(또는 새로고침 후 정리되지 않은 연결 40 개)면 그 레플리카의
> 스레드풀이 완전히 소진되고, 나머지 529 개 엔드포인트 전부가 그 뒤에 줄을 선다.**
> 이것이 "로깅이 무거워지면 응답이 없다"의 정확한 메커니즘이다. 로그가 무거워서가
> 아니라, **로그 스트림이 다른 모든 API 의 실행 슬롯을 뺏고 있는 것**이다.

**(c) 같은 스레드풀을 `kubectl` subprocess 호출이 나눠 쓴다.**

`subprocess.run(..., timeout=30)` 계열 호출이 코드 24 곳에 있다(`daily_checker`,
`health_checker`, `playbook_executor`, `k8s_helm`, `clusters`, `batch_jobs` 등).
대규모 클러스터에서 `kubectl get` 응답이 느려지면 이 호출들도 **최대 30 초씩**
같은 40 슬롯을 점유한다. (b)와 합쳐지면 고갈 속도가 훨씬 빨라진다.

**(d) 프로세스가 레플리카당 1 개다.**

```
backend/Dockerfile:72   CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
                        # ← --workers 없음 = 단일 프로세스
k8s/base/backend/deployment.yaml:11   replicas: 2
```

따라서 **전체 시스템의 sync 동시성 상한 = 40 × 2 = 80** 이다. 300 노드급 클러스터를
여러 개 붙여 쓰는 환경에서는 턱없이 부족하다.

부수적으로 `DB_POOL_SIZE=10` + `DB_MAX_OVERFLOW=20` = 프로세스당 30 커넥션이라,
스레드가 40 개여도 DB 접근은 30 에서 다시 막힌다(풀 대기).

### 2.2 이 문제가 TypeScript 로 해결되는가 — **아니다. 악화된다.**

Node.js 는 **이벤트 루프가 단 하나**다. Python 의 스레드풀 같은 완충 장치가 없다.

- 같은 코드를 TS 로 옮기면서 blocking 호출(`child_process.execSync`, 동기 fs,
  CPU 바운드 파싱)을 하나라도 쓰면 **프로세스 전체가 멈춘다.** Python 은 최악의
  경우에도 40 개 중 1 개를 잃을 뿐이다.
- 반대로 TS 를 제대로(전부 async) 쓰면 문제가 없는 것은 맞다. **그런데 그건
  Python 도 똑같다** — `async def` + async generator 로 쓰면 스트림 1,000 개도
  스레드 0 개로 처리한다.
- 즉 이 문제의 변수는 **언어가 아니라 "async 를 쓰는가"** 다. 8 만 줄을 다시
  쓰면서 async 규율을 배우는 것과, 지금 코드에서 async 규율을 적용하는 것 중
  후자가 압도적으로 싸다.

### 2.3 실제 수정안 (1~2일)

| # | 조치 | 대상 | 효과 |
|---|---|---|---|
| 1 | 스트리밍 핸들러를 `async def` + async generator 로 전환. K8s SDK 호출은 `httpx.AsyncClient` 로 직접 스트림하거나 `anyio.to_thread` + 큐 브리지 | `analyze.py` `stream_pod_logs`, `stream_cluster_events` (약 50 줄) | **스레드 점유 0** — 무응답의 직접 원인 제거 |
| 2 | `follow` 스트림에 최대 수명(예 30 분) + 클러스터/사용자당 동시 스트림 상한 | 위 두 핸들러 | 좀비 연결 누적 차단 |
| 3 | uvicorn `--workers 4` (또는 gunicorn + UvicornWorker) | `backend/Dockerfile:72` | 동시성 80 → 320 |
| 4 | anyio 스레드풀 한도를 CPU 기준으로 상향 (`main.py` lifespan 에서 `RunVar` 설정) | `main.py` | sync 핸들러 여유 확보 |
| 5 | `DB_POOL_SIZE`/`DB_MAX_OVERFLOW` 를 워커 수에 맞춰 재산정 (합계 ≤ Postgres `max_connections`) | `values-prod.yaml` | 풀 대기 제거 |
| 6 | subprocess `kubectl` 경로를 `asyncio.create_subprocess_exec` 로 이행 (점진) | 24 개 호출 지점 | kubectl 지연이 API 를 막지 않음 |

1~3 번만으로 보고된 증상은 해소된다. 4~6 은 후속 정리다.

---

## 3. 문제 ②: "Python 타입 문제가 많다" — 원인 특정

### 3.1 이 저장소는 타입 체커를 한 번도 실행한 적이 없다

확인 결과:

- `mypy.ini` / `pyrightconfig.json` / `pyproject.toml` / `setup.cfg` — **전부 없음**
- `backend/pytest.ini` 에는 pytest 설정만 있고 타입 검사 설정 없음
- `.github/workflows/ci.yml` 의 backend job 은 **`pytest` 만** 실행
- 반면 프론트엔드 job 은 `npm run lint` + **`tsc --noEmit`** + `build` 를 돌린다

즉 현재 상태는 **"Python 이라 타입이 약하다"가 아니라 "타입 검사를 켜지 않았다"** 이다.
TypeScript 도 `tsc` 를 CI 에서 돌리지 않으면 정확히 같은 상태가 된다 — 트랜스파일만
하고 타입 오류를 무시하면 런타임에 그대로 터진다.

체감상 "프론트는 타입 문제가 적고 백엔드는 많다"고 느껴지는 이유가 바로 이것이다.
**언어 차이가 아니라 게이트 유무의 차이다.**

### 3.2 어노테이션 현황

| 지표 | 값 |
|---|---|
| 함수 정의 | 1,891 개 |
| 인자 어노테이션이 있는 정의 | 1,072 개 (**약 57%**) |
| `Any` / `Dict[str, Any]` 계열 사용 | 352 회 |

절반 이상은 이미 타입이 붙어 있다. 밑바닥부터 시작하는 상황이 아니다.

### 3.3 기반은 이미 갖춰져 있다

이 프로젝트가 쓰는 스택은 **정적 타입 검사와 궁합이 가장 좋은 최신 조합**이다.

- **Pydantic v2** — 런타임 검증 + 정적 타입을 동시에 제공. 요청/응답 경계는
  이미 타입이 강제되고 있다(FastAPI 가 `response_model` 로 검증).
- **SQLAlchemy 2.0** — `Mapped[]` / `mapped_column()` 기반 완전 타입 지원.
  1.x 의 타입 없는 ORM 과는 다른 물건이다.
- **Python 3.11** — `Self`, `LiteralString`, 개선된 `TypedDict`, PEP 646 등 사용 가능.

빠진 것은 **스위치를 켜는 일** 하나다.

### 3.4 실제 수정안 (약 1주)

```bash
# 1) pyright 를 basic 모드로 도입, 현존 오류는 baseline 으로 억제
cd backend && npx pyright --outputjson > .pyright-baseline.json

# 2) CI 에 게이트 추가 — 신규/변경 코드에서만 실패시킴
#    .github/workflows/ci.yml 의 backend job 에 pyright 스텝 추가
```

- `pyrightconfig.json` 에 `typeCheckingMode: "basic"`, `strict` 대상 디렉터리를
  `app/schemas`, `app/models` 부터 점진 확대.
- `Any` 352 곳은 한 번에 없애지 않는다. 신규 코드 금지 규칙만 걸고, 손대는 파일
  단위로 정리(보이스카우트 규칙).
- 이 게이트 하나로 프론트엔드와 동일한 수준의 타입 안전성을 확보한다.

---

## 4. 언어 변경 시 실제 비용

### 4.1 대체 불가·고위험 의존성

TypeScript 로 옮길 때 **동등한 대체재가 없거나 성숙도가 크게 떨어지는** 것들:

| 현재 (Python) | 용도 | TS 대체 | 판정 |
|---|---|---|---|
| `ansible-core` + `ansible-runner` | Playbook 실행 (`playbooks/`, `ansible_assets`) | **없음** | ❌ Ansible 자체가 Python 이다. 프로세스 분리 외 방법 없음 |
| `kubernetes` (공식 Python SDK) | 클러스터 조회·로그·exec 전반 | `@kubernetes/client-node` | △ 존재하나 커버리지/성숙도 열세, exec/portforward 취약 |
| `paramiko` | SSH · PTY (WebSocket 핸들러 3 개, `ssh_pty.py`, `node_ssh`, `k9s_ssh`) | `ssh2` (네이티브 바인딩) | △ 재작성 + 네이티브 빌드 의존 |
| `pgvector` (Python) | 임베딩 검색 (`work_items`, `work_guide`, `ops_note`) | 수기 SQL | △ 가능하나 이점 없음 |
| `celery` + Beat | 11 개 스케줄 + 전체 태스크 | BullMQ / Temporal | ❌ 전면 재설계. Beat cron 디스패처 로직 전부 재작성 |
| `croniter` | check-matrix cron 평가(매분 디스패치) | `cron-parser` | ○ 대체 가능 |
| `openpyxl` / `xlrd` | Jira Excel 가져오기 | `exceljs` | ○ 대체 가능 |
| `feedparser` | 기술 트렌드 RSS 수집 | `rss-parser` | ○ 대체 가능 |
| `anthropic` SDK | LLM 분석기 | TS SDK 있음 | ○ 대체 가능 |

**핵심**: `deep_checkers/`, `lake_checkers/`, `bottleneck_probes/`, `batch_jobs/`,
`analyzers/` 는 전부 K8s SDK 와 subprocess 위에 얹혀 있다. 이 부분(services 28,599 줄의
큰 비중)이 이관 난이도의 대부분을 차지한다.

### 4.2 일정 추정

| 항목 | 규모 | 추정 |
|---|---|---|
| 라우터 이관 | 529 엔드포인트 / 27,852 줄 | 2~3 개월 |
| 서비스 이관 (체커·프로브·분석기·배치) | 141 파일 / 28,599 줄 | 3~5 개월 |
| ORM 모델 + 마이그레이션 재작성 | 60 모델 + `_run_migrations()` 인라인 방식 | 1~2 개월 |
| Celery → 잡 큐 재설계 | Beat 11 개 + 태스크 전체 | 1 개월 |
| 테스트 재작성 | 68 파일 / 11,958 줄 | 1~2 개월 |
| 안정화 (병행 운영·검증) | — | 2 개월 |
| **합계** | **81,547 줄** | **6~12 개월** |

여기에 더해:
- 이관 기간 중 **신규 기능 개발이 사실상 정지**하거나, 두 스택을 동시에 유지해야 한다.
  최근 3 개월간 백엔드 파일 410 개가 변경된 개발 속도를 고려하면 이 비용이 가장 크다.
- 폐쇄망(air-gap) 배포에서 npm 의존성 반입 체계를 새로 구축해야 한다
  (현재는 Alpine + pip 기준으로 `deploy-airgap.sh` 가 맞춰져 있다).
- 8 만 줄 재작성 과정에서 **새 버그가 유입된다.** 지금 안정적으로 도는 체커 로직이
  전부 검증 대상으로 되돌아간다.

### 4.3 대비: 개선안 비용

| | 언어 변경 | 개선안 (1·2단계) |
|---|---|---|
| 기간 | 6~12 개월 | **1~2 주** |
| 신규 기능 개발 정지 | 있음 | 없음 |
| 신규 버그 유입 위험 | 높음 (전면 재작성) | 낮음 (국소 수정) |
| 무응답 문제 해결 | 간접적 (재작성을 잘 했을 경우) | **직접적** |
| 타입 안전성 확보 | 확보됨 | **확보됨** |

---

## 5. "운영 경량화" 관점 검증

메모리만 놓고 보면 Node 가 유리한 것은 사실이다.

| | 유휴 RSS (대략) | 비고 |
|---|---|---|
| FastAPI + uvicorn (단일 워커) | 150~250 MB | SQLAlchemy·K8s SDK·Pydantic 로딩 포함 |
| Node + Fastify | 80~120 MB | |

현재 helm 설정은 backend `requests 384Mi / limits 1Gi`, `replicaCount 2` 다.

그러나:

1. **지금 병목은 메모리가 아니라 동시성 슬롯이다.** 무응답 증상은 OOM 이 아니라
   스레드풀 고갈에서 나온다(§2.1). 메모리를 절반으로 줄여도 증상은 그대로다.
2. **처리량은 I/O 바운드에서 동급이다.** PEP 의 워크로드는 거의 전부 I/O
   (K8s API, Postgres, Prometheus, SSH)다. `async` FastAPI 와 Node/Fastify 는 이
   영역에서 같은 자릿수의 처리량을 낸다. 지금 그 성능이 안 나오는 이유는 Python 이
   느려서가 아니라 **async 를 쓰지 않아서**다.
3. **메모리를 줄이고 싶다면 언어 변경보다 싼 방법이 있다** — gunicorn + UvicornWorker
   프리포크로 인터프리터/모듈을 COW 공유하면 워커 N 개의 실증 메모리가 N 배로 늘지
   않는다. 무거운 optional 의존(ansible-core, playwright 계열)을 워커 이미지에서
   분리하는 것도 유효하다.

---

## 6. 권고 로드맵

### 1단계 — 즉시 (1~2일): 무응답 해소
§2.3 의 1~3 번(스트리밍 async 전환 + 스트림 수명/상한 + uvicorn workers).
**이것이 실제로 보고된 장애를 고치는 유일한 작업이다.**

### 2단계 — 2주 내: 타입 안전성 확보
§3.4 의 pyright basic + baseline + CI 게이트. `docs-sync` 처럼 CI job 으로 고정해서
프론트엔드의 `tsc --noEmit` 과 동일한 지위를 준다.

### 3단계 — 4주 내: 잔여 정리
§2.3 의 4~6 번(스레드풀 한도, DB 풀 재산정, subprocess → async 이행).
로그성 테이블 purge 주기 점검, 페이지네이션 없는 `.all()` 124 곳 중 대용량
테이블 대상만 우선 정리.

### 4단계 — 1 분기 후: 재평가
1~3 단계 후에도 성능/타입 문제가 남는지 실측한다. 남는다면 그때는 구체적인 병목
데이터를 가지고 논의할 수 있다.

### 그래도 일부를 Node 로 가져가고 싶다면

전면 재작성 대신 **스트랭글러(strangler) 방식**으로 **실시간 스트리밍 게이트웨이만**
분리하는 안은 검토할 가치가 있다 — 로그 tail / 이벤트 SSE / 터미널 WebSocket 3 개만
Node 로 빼고, CRUD·체커·배치는 Python 에 남긴다. 이관 범위가 수천 줄 수준이고
경계가 명확하다.

**다만 1단계를 먼저 하면 그 분리도 불필요해질 가능성이 높다.** async 로 전환한
FastAPI 는 스트림 수천 개를 스레드 없이 처리한다. 순서를 지키는 것이 중요하다.

---

## 부록: 검증 명령

이 문서의 수치는 아래로 재현할 수 있다.

```bash
# 코드 규모
find backend -name '*.py' | wc -l
find backend -name '*.py' -exec cat {} + | wc -l

# sync / async 핸들러 비율
grep -rhn '^async def ' backend/app/routers/*.py | wc -l
grep -rhn '^def '       backend/app/routers/*.py | wc -l

# 엔드포인트 수
grep -rhn '@router\.\(get\|post\|put\|patch\|delete\)' backend/app/routers/*.py | wc -l

# 타입 체커 설정 부재 확인
ls backend | grep -i 'mypy\|pyright\|pyproject'      # 결과 없음

# 스레드풀 한도 조정 부재 확인
grep -rn 'RunVar\|_default_thread_limiter' backend/app/     # 결과 없음

# uvicorn 워커 설정
grep -n 'CMD' backend/Dockerfile
```
