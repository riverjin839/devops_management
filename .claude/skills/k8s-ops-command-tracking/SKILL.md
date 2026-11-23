---
name: k8s-ops-command-tracking
description: K8s 관리 앱에 "오래 걸리는 실행"(재시작·드레인·적용·롤백·수집 등)을 넣을 때 사용. KM(K8s Manager) 명령(Command) 모델(id/active/success/resultMessage/children/canRetry + fetch·wait·abort·retry), 일괄 명령(errors), 명령 카탈로그(argSchema) 패턴. 실행 버튼 → 명령 핸들 반환 → 실시간 로그·중단·재시도·하위 명령 트리가 필요하면 이 스킬을 따른다.
---

# Command tracking (KM 명령 모델)

> 레퍼런스 구현: [`reference.py`](reference.py) — 표준 라이브러리만, 저장소는 `CommandStore` 프로토콜로 주입.
> 분석 배경: `docs/03-analysis/km-borrow-analysis.md` §1.

## KM 패턴
| KM 개념 | 의미 | K8s 앱에서 |
|---|---|---|
| Command `{id,name,startTime,endTime,active,success,resultMessage}` | 변경 API 는 결과 대신 **명령 핸들**을 즉시 반환 | 실행 API 는 `202 {command_id}` 반환, 본 작업은 워커(Celery 등) |
| `children` / `parent` | 하위 명령 트리 | 롤링 재시작 = 부모, 노드/배치별 = 자식 |
| `fetch()` / `wait(timeout)` — 타임아웃 시 **예외가 아니라 마지막 상태** 반환 | 호출자가 "아직 실행 중"을 판단 | UI 폴링·SSE, 자동화 스크립트 대기 |
| `abort()` / `retry()` + `canRetry` | 중단·재시도 1급 기능 | 협조적 중단(단계 사이 `checkpoint()`), 재시도는 `parent_id` 로 원본 연결 |
| `SYNCHRONOUS_COMMAND_ID = -1` | 즉시 끝난 동기 명령도 같은 타입으로 | 빠른 조회형도 같은 결과 스키마로 응답 |
| 일괄 명령 `errors` | N개 대상 중 일부 제출 실패를 모아서 | 일괄 실행: 검증 실패 대상은 `errors`, 나머지는 진행 |
| 명령 메타데이터 `{name,argSchema}` + 대상별 명령 목록 | 대상이 지원하는 명령과 인자 스키마를 서버가 알려줌 | 리소스 종류별 명령 카탈로그 → **UI 가 스키마로 폼을 그림**(UI-First) |

## 규칙
1. **실행 API 는 블로킹하지 않는다.** 명령 행을 먼저 만들고 id 를 돌려준 뒤 워커에서 실행.
2. **로그는 줄 단위로 즉시 커밋**한다(`CommandContext.log`). 끝에 한 번에 쓰면 실시간 로그가 불가능.
   - 이 저장소 규칙(CLAUDE.md custom): 모든 "실행" 버튼은 상세·실시간 로그를 함께 구현하고
     사용자가 "로그 보기" 를 켜고 끌 수 있어야 한다 → FE 는 `RunLogPanel` + 로그 보기 토글.
3. **상태는 `running → succeeded|failed|aborted`** 의 단일 축. `success=None` 은 실행 중.
4. **중단은 협조적**: 단계 사이 `ctx.checkpoint()`. 외부 프로세스(kubectl/ssh)는 타임아웃을 반드시 둔다.
5. **재시도는 새 명령**(원본 불변, `parent_id` 연결). 이력이 지워지지 않는다.
6. 명령 카탈로그의 `mutating=False`(조회형)는 확인 없이, `danger=True` 는 2단계 확인(DESIGN_SYSTEM §12.6.1).
7. 인자는 `arg_schema` 로 서버에서도 검증한다(`validate_args`). 프런트 검증만 믿지 않는다.

## 사용 예
```python
from reference import CommandManager, InMemoryStore
mgr = CommandManager(InMemoryStore())

def restart_deploy(ctx):
    ctx.log("patch restartedAt", step="patch"); ctx.checkpoint()
    ctx.log("wait rollout", step="wait")
    return "rolled out"

cmd = mgr.submit("rollout_restart", restart_deploy, target={"ns": "app", "name": "api"},
                 run=lambda f: celery_task.delay())   # 실제로는 Celery 태스크 안에서 _body 호출
final = mgr.wait(cmd.id, timeout=300)                 # 타임아웃이면 active=True 인 마지막 상태
```

## PEP 적용 지점
- 이미 같은 철학의 실행 로그 모델이 있다: `K8sEfficiencyRun`(steps·log_lines 단계별 커밋),
  `ServiceConfigApplyRun`, `NsMigrationRun`, `BatchJobRun`, `PlaybookRun`. **새 실행형 기능은 이 중 하나를
  확장하거나 같은 컬럼 형태(`status`, `steps` JSONB, `log_lines` Text, `parent_run_id`)로 만든다.**
- 중단: 수동 실행은 `services/active_runs.py`, Celery 실행은 `revoke(terminate=True)` — 여기에
  `abort_requested` 플래그 + `checkpoint()` 를 더하면 다중 replica 에서도 일관된 중단이 된다.
- FE: `components/common/RunLogPanel.tsx`(fill) + 로그 보기 토글, 결과는 `ExecOutputTabs`.

## 체크리스트
- [ ] 실행 API 가 202 + command/run id 를 반환한다
- [ ] 로그가 줄/단계 단위로 커밋되고 FE 가 폴링/SSE 로 실시간 표시, "로그 보기" 토글 제공
- [ ] abort / retry 엔드포인트와 버튼(viewer 는 `useCanOperate()` 로 disabled + 사유)
- [ ] 하위 명령(노드/배치별)이 있으면 부모-자식 관계 저장
- [ ] 실행 이력 테이블은 `LOG_TABLES` + 보존 기간 등록(backup_service 규칙)
