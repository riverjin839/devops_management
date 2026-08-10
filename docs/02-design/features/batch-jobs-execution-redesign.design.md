# batch-jobs-execution-redesign Design Document

> **Summary**: Batch Jobs·점검 매트릭스의 "실행"을 DB 저장·버전관리·UI 편집·테스트가 되는
> 통일된 스크립트 자산(Python/Ansible/Shell) 기반으로 재설계하고, 실행 위치(서버/파일)
> 투명성과 셀 단위 즉시실행을 추가한다.
>
> **Project**: PEP (Platform Engineering Portal)
> **Version**: N/A (아키텍처 제안 — 버전 확정 전)
> **Author**: riverjin839 (요청) / Claude 작성
> **Date**: 2026-08-06
> **Status**: Draft — 리뷰/우선순위 결정 대기
> **Planning Doc**: 없음 — 이 문서가 최초 제안을 겸한다. 착수 확정 시 단계별 `plan.md` 를
> Phase 별로 분리한다(§9 참고).

---

## Context Anchor

| Key | Value |
|-----|-------|
| **WHY** | ① 모든 실행이 UI 로 보이지 않음(어떤 파일/서버/코드인지 불투명) ② 실행 코드가 파이썬 파일에 하드코딩돼 있어 UI 편집·재사용·버전관리가 불가능 ③ `Deep Check`/`Addon`/`수동 입력` 분류가 "어느 config 모델을 쓰는가"라는 내부 구현 기준이라 사용자에게 근거가 안 보임 ④ 매트릭스 셀에 즉시실행이 없음(모달을 열어야만 실행 가능) |
| **WHO** | Batch Jobs·점검 매트릭스를 운영하는 모든 관리자/운영자(admin, operator 권한) |
| **RISK** | 기존 `DeepCheckerBase`/`REGISTRY`(딥체크 9종)·`services/checkers/`(Addon 8종)·`batch_jobs`(3종)는 이미 프로덕션에서 도는 코드다 — 빅뱅 교체는 회귀 위험이 크다. **단계적 병행(strangler fig) 전략 필수** — 새 스크립트 모델을 신규 경로로 먼저 열고, 기존 하드코딩 체커는 당분간 그대로 둔다 |
| **SUCCESS** | (1) 새 Batch Job 은 파이썬 파일 없이 UI 에서 스크립트 작성→저장→버전관리→실행까지 완결 (2) 매트릭스 셀에 즉시실행 ▶ + 확인 팝업 (3) 실행 방식 배지가 Python/Ansible/Shell/내장 점검/수동 입력 5종으로 재분류 (4) 모든 실행 상세에 "이 스크립트가 어디 저장돼 있고 어느 서버에서 실행됐는지"가 보임 |
| **SCOPE** | Phase 0: 매트릭스 셀 즉시실행(스키마 변경 없음). Phase 1: 스크립트 자산 모델+라이브러리 화면+테스트 실행. Phase 2: Batch Jobs 를 스크립트 기반으로 전환. Phase 3: 점검 매트릭스 실행 방식 용어 개편. Phase 4(선택): 기존 내장 체커 일부를 스크립트로 이관 |

---

## 1. Overview — 요청사항 → 해결 매핑

사용자가 나열한 7개 요구사항을 그대로 인용하고, 각각을 이 설계의 어느 절이 해결하는지 명시한다(빠짐없이 다뤘는지 자체 검증용).

| # | 요청 (원문 요약) | 해결 절 |
|---|---|---|
| 1 | 모든 동작은 UI 에서 확인 가능해야 한다 | §4 API, §5.3(실행 방식 탭), §5.4(스크립트 라이브러리) — 이미 있는 `ExecutionStepsTimeline`/`CommandTraceList` 를 스크립트 실행에도 그대로 재사용 |
| 2 | 어떤 서버에 어떤 파일이 있고 어디서 실행되는지 표시 | §5.5 "실행 위치 패널" — 스크립트 저장 위치(DB, 버전) + 실행 대상(호스트/클러스터) 을 함께 노출하는 신규 UI 블록. 기존 `check_matrix_runbook.py`/`resolve_kubeconfig` 의 "사유 노출" 패턴을 확장 |
| 3 | 동작하는 코드/파일은 EDIT 가능해야 한다 | §3 데이터 모델 — `executable_script_versions` (수정 시 새 버전 생성, 파괴적 덮어쓰기 없음) + §5.4 Monaco 기반 인라인 에디터 |
| 5 | 개별 JOB 은 실행/실행중지/취소/EDIT 가능해야 한다 | §2.3 — Batch Jobs 는 이미 run/stop(=cancel) 인프라(`CancelToken`/`active_runs`/Celery revoke)가 있음(재사용, 신규 아님). EDIT 은 §3 스크립트 버전 편집으로 확장 |
| 6 | 매트릭스 셀에 개별 즉시실행 버튼(확인 팝업) | §7 Phase 0 — 가장 작고 독립적인 변경, 즉시 착수 가능 |
| 7-1 | Deep Check/Addon/수동입력 용어 불명확 → 실사용 방식 단위로 개편 | §6 용어 개편 |
| 7-2 | Python/Ansible/Shell 기본 3방식, DB 파일 저장·수정·버전관리·재사용·UI 로드·UI 테스트 | §3 데이터 모델, §4 API(`/scripts/*`), §5.4 스크립트 라이브러리 화면 |

### 1.1 Design Goals

- **실행 메커니즘을 1급 시민으로**: "무엇을 실행하는가"(스크립트: python/ansible_playbook/shell)와 "어디서·언제 실행하는가"(대상: 클러스터/호스트, cron)를 분리한다 — 지금은 이 둘이 `job_type`(파이썬 클래스)/`check_type`(파이썬 클래스)에 뭉쳐 있어 재사용도, UI 편집도 안 된다.
- **기존 실행 추적 인프라는 재사용, 재발명 금지**: `ExecutionStep`/`_step()`/`_record_command()`/`step_plan`(딥체크·배치잡에 이미 중복 구현돼 있음, `deep_checkers/base.py` ↔ `batch_jobs/base.py`)을 스크립트 실행에도 그대로 적용한다. 이번 기회에 공용 모듈로 뽑는 것도 고려(§8).
- **파괴적 변경 없음, 버전으로 편집**: 스크립트를 고치면 새 버전이 생기고 이전 버전은 남는다 — 실행 이력(`run.script_version_id`)이 "그때 실제로 뭐가 돌았는지" 항상 정확히 가리키게 한다(`BatchJobRun.params_snapshot` 과 동일 철학).
- **자격증명은 스크립트에 절대 안 담는다**: 기존 UI-First 원칙(CLAUDE.md) 그대로 — 스크립트 `content`/`param_schema` 는 JSONB/Text 로 실행 로그·런북에 노출되므로, SSH 비밀번호 등은 여전히 잡/클러스터의 별도 암호화 필드(`encrypted_password` 등)에만 저장하고 스크립트는 `{{ target_host }}` 같은 플레이스홀더만 참조한다.

### 1.2 Design Principles

- Strangler fig — 기존 `DeepCheckerBase`/`REGISTRY`/`services/checkers/` 는 건드리지 않는다. 새 스크립트 모델은 **병행 경로**로 추가하고, Batch Jobs 부터 먼저 옮긴다(리스크가 가장 낮음 — 이미 파라미터가 JSONB 자유 형식이라 스키마 충격이 작다).
- 기존 컴포넌트 재사용 — `ExecutionStepsTimeline`, `CommandTraceList`, `ConfirmDialog`, `CancelToken`/`active_runs`, `resolve_kubeconfig` 의 사유 노출 패턴을 그대로 쓴다. 신규 UI 프리미티브를 만들지 않는다.
- 한국어 실행 방식 라벨은 사용자가 실제로 고르는 기준(무엇을 실행하는가)에 맞춘다 — 내부 구현(어느 SQLAlchemy 모델을 쓰는가)을 라벨로 노출하지 않는다.

---

## 2. Architecture Options

### 2.0 Architecture Comparison

| Criteria | Option A: Strangler fig (신규 스크립트 모델 병행, 단계적 이관) | Option B: 빅뱅 재작성(REGISTRY/checkers 전체를 스크립트 모델로 즉시 대체) | Option C: 스크립트 저장만 추가, 실행기는 그대로(순수 문서화 개선) |
|---|:-:|:-:|:-:|
| **Approach** | 새 `executable_scripts` 모델을 신규 실행 경로로 열고, Batch Jobs → 매트릭스 순으로 이관. 기존 딥체크/애드온은 유지 | REGISTRY·checkers·batch_jobs 를 한 번에 스크립트 기반으로 교체 | 스크립트 내용을 DB 에 "설명용"으로만 저장, 실제 실행은 여전히 하드코딩 파이썬이 담당(스크립트는 실행되지 않음) |
| **회귀 위험** | 낮음 — 기존 9+8+3=20개 실행기 무변경 | 매우 높음 — 프로덕션 점검·정리 잡 전체가 한 번에 바뀜, TLS/타임아웃 등 최근 수정한 안전장치도 재구현 필요 | 없음(실행 로직 무변경) |
| **요구사항 충족도** | 높음 — #3(EDIT)·#7-2(버전관리/재사용/테스트) 전부 실질 충족 | 높음(이론상) | 낮음 — "EDIT 가능"이 거짓이 됨(고쳐도 반영 안 됨) |
| **개발 비용** | 중 — Phase 로 분산 | 매우 높음, 단일 릴리스로 부담 | 낮음 |
| **유지보수성** | 높음 — 신규 코드는 통일된 모델, 레거시는 자연 감소(신규 체커를 굳이 파이썬으로 안 만들게 됨) | 높음(장기) | 낮음 — 설명과 실제 동작이 어긋날 위험(거짓 문서화) |
| **Recommendation** | **선택** | 비권장(리스크 대비 이득 불충분) | 비권장(요구사항 #3 미충족) |

**Selected**: **Option A — Strangler Fig**
**Rationale**: 사용자가 명시한 요구사항(EDIT 가능, 테스트 가능, 버전관리)은 스크립트가 **실제로 실행되는** 것을 전제한다 — Option C 는 겉으로만 그럴듯한 문서화라 요구사항을 만족하지 않는다. Option B 는 이번 세션에서 막 고친 K8s 타임아웃/TLS 분류(`_TimeoutGuardedApi`, `_TLS_ERROR_HINTS`) 같은 안전장치를 포함해 검증된 로직을 통째로 재구현해야 해 리스크 대비 이득이 낮다. Option A 는 가장 위험이 낮은 Batch Jobs 부터 시작해 점진적으로 검증하며 확장할 수 있다.

### 2.1 핵심 개념 다이어그램

```
지금(As-Is)                                   앞으로(To-Be, Option A)
─────────────────────                         ─────────────────────────────
BatchJob                                       BatchJob
  job_type: str (파이썬 클래스명)                  execution_mode: 'system' | 'script'
  params: JSONB (자유형식)                          script_id → ExecutableScript ──┐
  ↓ REGISTRY 조회 (redeploy 필요)                    script_version_id (nullable=최신) │
  services/batch_jobs/*.py (하드코딩)                params: JSONB (스크립트 param_schema 대응) │
                                                                                    │
CheckMatrixItem                                CheckMatrixItem                     │
  source_type: core_bundle|deep_check|addon|manual   source_type: core_bundle|deep_check|addon|
  source_ref: str (REGISTRY/Addon.type 키)              manual|script  ← 신규
  ↓ REGISTRY/Addon 조회 (redeploy 필요)               source_ref: 위와 동일 이거나 script_id  │
  services/deep_checkers/*.py, services/checkers/*.py (하드코딩, 무변경)               │
                                                                                    │
                                                ExecutableScript ◄──────────────────┘
                                                  kind: python | ansible_playbook | shell
                                                  name, description, tags, is_system
                                                  current_version_id
                                                    ↓ 1:N
                                                  ExecutableScriptVersion
                                                    version(int), content(text),
                                                    inventory_content(text, ansible 용),
                                                    param_schema(jsonb), changelog,
                                                    created_by, created_at
```

### 2.2 실행 흐름 (스크립트 기반 Batch Job 예시)

```
[운영자가 스크립트 라이브러리에서 새 Shell 스크립트 작성]
1. POST /api/v1/scripts { name, kind: "shell", content: "..." }
   → ExecutableScript + ExecutableScriptVersion(version=1) 생성
2. "테스트 실행" 클릭 → POST /scripts/{id}/test-run { target: {host,...}, params }
   → 저장 없이 즉시 실행, ExecutionStepsTimeline 으로 결과 확인(§4.3)
3. 만족스러우면 Batch Job 생성 마법사에서 이 스크립트 선택 → BatchJob.script_id 연결

[예약 실행 — 지금과 동일한 Celery 경로]
4. cron 도래 → run_batch_job.delay(job_id)
5. execute_job() 이 job.script_id 있으면 새 ScriptExecutor 로 분기(기존 REGISTRY 분기와 병행)
   → ExecutableScriptVersion(현재 활성 버전).content 로드 → kind 별 실행기로 실제 실행
   → 기존과 동일하게 BatchJobRun.steps/commands 기록, script_version_id 도 함께 기록

[스크립트 수정]
6. 라이브러리에서 content 수정 → 저장 시 새 ExecutableScriptVersion(version=2) 생성
   (기존 version=1 은 불변으로 보존 — 과거 실행 이력은 여전히 v1 을 정확히 가리킴)
7. Job 이 "항상 최신"(script_version_id=null)이면 다음 실행부터 v2 적용,
   특정 버전에 고정(script_version_id=1)했다면 v2 무시하고 계속 v1 실행
```

### 2.3 Run/Stop/Cancel/Edit — 기존 인프라 재사용 확인 (요청 #5)

| 기능 | 지금 상태 | 스크립트 모델에서 |
|---|---|---|
| 실행 | `POST /batch-jobs/{id}/run`(동기) | 무변경 — `execute_job()` 내부 분기만 추가 |
| 예약 실행 | Celery `run_batch_job.delay()` | 무변경 |
| 실행 중지 | `POST /{id}/stop` → `CancelToken`(수동) 또는 Celery revoke(예약) | 무변경 — `ScriptExecutor` 도 동일하게 `CancelToken` 을 받는다 |
| 취소(대기열에서 아직 안 돈 것) | Celery revoke(비-terminate) | 무변경 |
| EDIT | **오늘은 `params`(JSONB) 만 편집 가능, 실행 로직 자체는 편집 불가** | **신규** — 스크립트 `content` 자체를 라이브러리에서 편집(새 버전 생성) |

---

## 3. Data Model

### 3.1 신규 테이블

```python
# backend/app/models/executable_script.py (신규)

class ScriptKind(str, enum.Enum):
    python = "python"
    ansible_playbook = "ansible_playbook"
    shell = "shell"

class ExecutableScript(Base):
    __tablename__ = "executable_scripts"
    id = Column(UUID, primary_key=True, default=uuid.uuid4)
    name = Column(String(200), nullable=False)
    description = Column(Text, nullable=True)
    kind = Column(Enum(ScriptKind), nullable=False)
    tags = Column(JSONB, nullable=True)           # ["etcd", "cleanup"] — 검색/재사용 필터
    is_system = Column(Boolean, default=False)     # 시드 스크립트(기존 3종 이관분) — 삭제 방지, 포크는 허용
    current_version_id = Column(UUID, ForeignKey("executable_script_versions.id"), nullable=True)
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    updated_at = Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)

class ExecutableScriptVersion(Base):
    __tablename__ = "executable_script_versions"
    id = Column(UUID, primary_key=True, default=uuid.uuid4)
    script_id = Column(UUID, ForeignKey("executable_scripts.id"), nullable=False)
    version = Column(Integer, nullable=False)       # 스크립트별 1부터 증가
    content = Column(Text, nullable=False)           # python 코드 / shell 스크립트 / ansible playbook yaml
    inventory_content = Column(Text, nullable=True)  # ansible_playbook 전용 — 인벤토리 템플릿
    param_schema = Column(JSONB, nullable=True)      # [{name, label, type, default, help}, ...] — DeepCheckFieldSpec 과 동일 shape 재사용
    changelog = Column(Text, nullable=True)          # "etcd env 경로 기본값 수정" 같은 사용자 메모
    created_by = Column(String(100), nullable=True)
    created_at = Column(DateTime, default=datetime.utcnow)
    __table_args__ = (UniqueConstraint("script_id", "version"),)
```

- `_safe_add_column`/`_safe_create_index` 로 `main.py` 마이그레이션에 등록(CLAUDE.md §Database 규칙 그대로 따름).
- `param_schema` 는 기존 `DeepCheckFieldSpec`(`registry.py`)과 같은 shape 로 맞춘다 — UI 폼 렌더 컴포넌트를 그대로 재사용하기 위함(`CheckMatrixRunbookPanel.tsx` 의 `SourceConfigEditor` 가 이미 `fieldSpecs` 기반 폼을 그린다).

### 3.2 기존 테이블 확장

```python
# BatchJob 에 추가 (backend/app/models/batch_job.py)
execution_mode = Column(String(20), default="system")  # 'system'(기존 job_type) | 'script'(신규)
script_id = Column(UUID, ForeignKey("executable_scripts.id"), nullable=True)
script_version_id = Column(UUID, ForeignKey("executable_script_versions.id"), nullable=True)  # null=항상 최신

# BatchJobRun 에 추가
script_version_id = Column(UUID, ForeignKey("executable_script_versions.id"), nullable=True)  # 실행 시점에 스냅샷

# CheckMatrixItem 에 추가
# source_type 에 'script' 값 추가(기존 enum 확장)
script_id = Column(UUID, ForeignKey("executable_scripts.id"), nullable=True)
script_version_id = Column(UUID, ForeignKey("executable_script_versions.id"), nullable=True)
```

- `source_type='script'` 일 때 `source_ref` 는 안 쓰고 `script_id`/`script_version_id` 를 쓴다 — 기존 `deep_check`/`addon` 은 `source_ref`(문자열 키) 방식 그대로 무변경.

---

## 4. API Specification

### 4.1 스크립트 라이브러리 CRUD + 버전

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/v1/scripts` | 목록(`kind`/`tags`/검색 필터) |
| POST | `/api/v1/scripts` | 신규 생성(최초 버전=1 동시 생성) |
| GET | `/api/v1/scripts/{id}` | 상세(현재 버전 content 포함) |
| PUT | `/api/v1/scripts/{id}` | 메타(name/description/tags) 수정 — **content 는 여기서 안 바꿈** |
| DELETE | `/api/v1/scripts/{id}` | 삭제(연결된 Job/Item 있으면 409 — 참조 정리 유도) |
| POST | `/api/v1/scripts/{id}/versions` | **새 버전 생성(= "저장" 버튼의 실제 동작)** — content/changelog 필수 |
| GET | `/api/v1/scripts/{id}/versions` | 버전 이력 목록 |
| GET | `/api/v1/scripts/{id}/versions/{v}` | 특정 버전 content 조회(diff 뷰용) |
| PUT | `/api/v1/scripts/{id}/current-version` | "이 버전을 기본으로" 지정(롤백) |

### 4.2 실행 연결(기존 라우터 확장, 신규 라우터 아님)

- `POST /api/v1/batch-jobs` — body 에 `executionMode: 'script'`, `scriptId`, `scriptVersionId?` 추가(기존 `jobType` 은 `executionMode: 'system'` 일 때만 필수로 완화).
- `POST/PUT /api/v1/check-matrix/items` — `sourceType: 'script'` 일 때 `scriptId`/`scriptVersionId` 필드 추가.

### 4.3 테스트 실행 (요청 #7-2 핵심)

```
POST /api/v1/scripts/{id}/test-run
{
  "content": "...",              // 저장 전 초안도 테스트 가능(버전 저장 없이)
  "target": {                    // 절대 저장되지 않음 — 요청 시에만 사용(기존 SSH 수집 패턴과 동일 원칙)
    "kind": "ssh" | "cluster",
    "host": "10.0.0.5", "port": 22, "username": "root",
    "password": "...", "privateKey": "...",
    "clusterId": "..."           // kind=cluster 면 kubeconfig 재구체화 경로 사용
  },
  "params": { "env_file": "/etc/etcd.env" }
}
→ 200 { steps: [...], commands: [...], stdout, stderr, exitCode, durationMs }
```

- 자격증명 미저장 원칙은 §1.1·CLAUDE.md UI-First 원칙 §3 을 그대로 따른다(etcd_defrag/cert_expiry 의 "요청 시에만 SSH 자격증명 사용" 선례와 동일).
- 결과는 `BatchJobRun`/`CheckMatrixRun` 에 안 쌓는다(테스트이지 실제 잡이 아님) — 별도 응답으로만 반환, 영속 저장 안 함(스토리지 낭비·이력 오염 방지).
- 실행은 `kind` 에 따라 분기: `shell`→SSH(`ssh_runner.py` 재사용), `ansible_playbook`→`ansible-runner`(기존 `run_playbook()` 재사용), `python`→ 대상 서버에 SSH 로 접속해 `python3 -` 로 스크립트를 stdin 전달(SavedScript 의 `script_wrap.py` 패턴 재사용) 또는 in-cluster 배치잡이면 백엔드 프로세스 내 격리 실행(리스크 높음 — Phase 1 에서는 **원격 SSH 실행만 지원**하고 백엔드 프로세스 내 실행은 제외하는 것을 권장, §7 참고).

---

## 5. UI/UX Design

### 5.1 매트릭스 셀 즉시실행 (Phase 0, 요청 #6)

```tsx
// PlatformStatusMatrix.tsx — CellButton 내부에 hover 시 노출되는 ▶ 아이콘 추가
function CellButton({ item, cell, onClick, onRunNow }: {...}) {
  const [confirming, setConfirming] = useState(false);
  return (
    <div className="relative group">
      <button onClick={onClick}>{/* 기존 셀 클릭 = 상세 모달 */}</button>
      {item.sourceType !== 'manual' && (
        <button
          className="absolute top-0.5 right-0.5 opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-secondary"
          onClick={(e) => { e.stopPropagation(); setConfirming(true); }}
          title="지금 실행" aria-label={`${item.name} 지금 실행`}
        >
          <Play className="w-3 h-3 text-primary" />
        </button>
      )}
      {confirming && (
        <ConfirmDialog
          title="지금 실행"
          description={`"${item.name}" 을(를) ${cluster.name} 에서 지금 실행하시겠습니까?`}
          confirmLabel="실행"
          onConfirm={() => { onRunNow(); setConfirming(false); }}
          onCancel={() => setConfirming(false)}
        />
      )}
    </div>
  );
}
```

- `ConfirmDialog`(`components/common/ConfirmDialog.tsx`)와 `useRunCheckMatrixCell()`(이미 존재)를 그대로 재사용 — **신규 백엔드 변경 없음**, 프론트만으로 완결.
- 클릭 시 이벤트 버블링으로 상세 모달이 같이 열리지 않도록 `stopPropagation()` 필수.

### 5.2 실행 방식 배지 (요청 #7-1, §6 과 연동)

| 배지 | 색/아이콘 | 조건 |
|---|---|---|
| 핵심 | 회색, `Lock` | `core_bundle`(무변경) |
| 내장 점검 | 파랑, `ShieldCheck` | `deep_check`/`addon`(레거시, 명칭만 통합) |
| Python | 초록, `FileCode` | `script` + `kind=python` |
| Ansible | 주황, `Boxes` | `script` + `kind=ansible_playbook` |
| Shell | 보라, `Terminal` | `script` + `kind=shell` |
| 수동 입력 | 회색, `PenLine` | `manual`(무변경) |

### 5.3 실행 방식 탭 확장 — "실행 위치" 패널 (요청 #2)

`CheckMatrixRunbookPanel.tsx`/`BatchJobSlideOver.RunForm.tsx` 공통으로 상단에 신규 섹션 추가:

```
┌─ 실행 위치 ────────────────────────────────────────────────┐
│ 스크립트 소스   ExecutableScript #a1b2 "etcd 압축"  v3       │
│                 (2026-08-01 수정, "타임아웃 값 조정")  [편집] │
│ 실행 대상       SSH root@10.0.0.5:22 (master-1)              │
│ 실행 위치       원격 호스트에서 bash -lc 로 직접 실행         │
└────────────────────────────────────────────────────────────┘
```

- "스크립트 소스" 클릭 → 스크립트 라이브러리 상세로 이동(딥링크 `/scripts/{id}?v=3`).
- 기존 `runbook.target`/`runbook.kubectlPrefix`(런북 패널에 이미 있음)를 이 패널의 "실행 대상" 필드로 흡수 — 중복 표시 방지.

### 5.4 스크립트 라이브러리 화면 (신규, `/scripts`)

- `ClusterSidebar` 미사용(스크립트는 클러스터 종속 아님) — 대신 좌측에 `kind` 필터(Python/Ansible/Shell 전체) + 태그 검색.
- 목록 → 상세: Monaco 에디터(`kind` 에 따라 syntax highlighting: python/yaml/shell) + 우측 "버전 이력" 사이드패널(버전별 changelog, 클릭 시 diff).
- 상세 화면 액션바: **저장(새 버전)** / **테스트 실행** / **이 버전으로 롤백**.
- "테스트 실행" 클릭 → 대상 입력 폼(호스트 또는 클러스터 선택 + SSH 자격증명, 저장 안 함) → 실행 → `ExecutionStepsTimeline` + `CommandTraceList`(기존 컴포넌트 재사용) 로 결과 표시.
- "어디서 쓰이나" 섹션 — 이 스크립트를 참조하는 BatchJob/CheckMatrixItem 목록(역참조, 삭제 전 확인용).

### 5.5 Page UI Checklist

#### PlatformStatusMatrix (Phase 0)
- [ ] 셀 hover 시 ▶ 아이콘 노출(수동 입력 항목 제외)
- [ ] 클릭 시 `ConfirmDialog`("정말 실행하시겠습니까?") 표시, 셀 상세 모달은 안 열림
- [ ] 확인 시 기존 `useRunCheckMatrixCell()` 호출, 완료 토스트

#### 스크립트 라이브러리 (Phase 1, 신규 `/scripts`)
- [ ] 목록: kind 필터 + 태그 검색 + "새 스크립트"
- [ ] 상세: Monaco 에디터 + 버전 이력 사이드패널
- [ ] 저장 = 새 버전 생성(변경사항 없으면 버튼 비활성화)
- [ ] 테스트 실행 폼(대상 입력, 자격증명 비저장 안내 문구 필수 — 기존 SSH 수집 모달들의 문구 재사용)
- [ ] 테스트 실행 결과 = ExecutionStepsTimeline + CommandTraceList
- [ ] "어디서 쓰이나" 역참조 목록

#### BatchJobSlideOver / CreateBatchJobWizard (Phase 2)
- [ ] "타입" 스텝에 "시스템 제공"(기존 3종) vs "스크립트 선택"(라이브러리에서 고르기 또는 새로 작성) 분기
- [ ] 스크립트 선택 시 버전 고정 여부(항상 최신 / 특정 버전) 토글

---

## 6. 실행 방식 용어 개편 (요청 #7-1)

| 지금 | 사용자에게 불명확한 이유 | 개편 후 |
|---|---|---|
| `core_bundle`(핵심) | 그대로 유지해도 무방 — Cluster.status 산정과 직결된다는 것만 명확히 툴팁 보강 | **핵심**(무변경, 툴팁: "클러스터 상태 판정에 직접 쓰이는 내장 점검 — 삭제 불가") |
| `deep_check`("Deep") | "Deep"이 무엇의 반대말인지 사용자가 알 길이 없음(내부적으로는 "Addon 이 아닌, params/thresholds 기반 체커"라는 뜻) | **내장 점검**(레거시, 파이썬 하드코딩이라는 사실을 툴팁에 명시: "PEP 가 기본 제공하는 점검 — 코드 수정은 배포가 필요합니다") |
| `addon`("Addon") | "Addon"이 K8s 애드온(ArgoCD 등) 등록 여부에 달려 있다는 전제가 화면에 안 보임 | **내장 점검**으로 `deep_check` 와 라벨 통합(사용자 입장에선 둘 다 "코드로 미리 만들어진 점검"이라 구분 의미가 약함) — 필요하면 상세 툴팁에서만 "애드온 등록 기반"이라고 구분 |
| (없음) | 스크립트 기반 실행이 아예 없었음 | **Python 스크립트 / Ansible Playbook / Shell 스크립트** 3종 신설 — §5.2 배지 |
| `manual`(수동 입력) | 비교적 명확하지만 "실행"과 나란히 있어 헷갈릴 수 있음 | **수동 값 입력**으로 라벨만 보강(실행이 아니라 사람이 직접 값을 적어 넣는다는 것을 명시) |

- **DB enum 값 자체(`deep_check`/`addon`)는 안 바꾼다** — 코드 전역에 참조가 많고(§Research B) 라벨은 프론트 상수 하나(`SOURCE_BADGE`, `PlatformStatusMatrix.tsx`)만 바꾸면 되므로 문자열 변경보다 훨씬 안전하다. "용어 개편"은 **UI 라벨/툴팁 개편**이지 스키마 마이그레이션이 아니다.

---

## 7. Migration / Phasing

| Phase | 내용 | 리스크 | 선행조건 |
|---|---|---|---|
| **0** | 매트릭스 셀 즉시실행 + 확인 팝업(§5.1) | 매우 낮음 — 프론트만, 기존 API 재사용 | 없음, 즉시 착수 가능 |
| **1** | `executable_scripts`/`executable_script_versions` 모델 + `/scripts` 라이브러리 화면 + 테스트 실행(§3, §4.1, §4.3, §5.4). **아직 어떤 Job/Item 도 여기 연결 안 함** | 낮음 — 신규 테이블·신규 화면, 기존 코드 무변경 | 없음 |
| **2** | BatchJob 에 `execution_mode='script'` 배선(§3.2, §4.2). 기존 3개 executor(`etcdctl_defrag`/`shell_command`/`k8s_job_cleanup`)를 `is_system=true` 시드 스크립트로 포팅 — **동작은 100% 동일하게 유지**하면서 내용만 DB 로 옮김 | 중간 — 기존 잡 마이그레이션 스크립트 필요, 회귀 테스트 필수 | Phase 1 |
| **3** | `CheckMatrixSourceType.script` 추가 + 매트릭스 실행 방식 라벨 개편(§6) | 중간 — enum 확장은 안전하지만 프론트 배지·필터 전수 확인 필요 | Phase 1 |
| **4(선택)** | 기존 딥체크/애드온 중 단순한 것(예: HTTP 헬스체크류)을 스크립트로 재구현 — 복잡하거나 상태 산정에 깊이 얽힌 것(core_bundle, cert_expiry 의 스냅샷 폴백 등)은 **영구히 파이썬 유지** | 케이스별 상이 | Phase 2, 3 |

**Phase 4 를 "선택"으로 명시한 이유**: 최근 세션에서 딥체크 타임아웃 프록시(`_TimeoutGuardedApi`)·TLS 오분류 수정(`_TLS_ERROR_HINTS`)을 방금 넣었다 — 이런 안전장치는 `DeepCheckerBase` 공용 계층에 있어 스크립트 모델로 이관해도 자동으로 안 따라온다. 무리하게 전량 이관하지 말고, **신규 체커는 스크립트로, 기존 체커는 그대로**가 현실적인 장기 방향이다.

---

## 8. Open Questions (착수 전 결정 필요)

1. **Python 스크립트 실행 위치**: 원격 SSH(대상 서버에 Python3 필요) 만 지원할지, PEP 백엔드/워커 프로세스 내에서 직접 실행(샌드박스 필요 — RCE 리스크)까지 지원할지. **권장: Phase 1~2 는 원격 SSH 실행만, 백엔드 내 실행은 범위 제외**(보안 검토 별도 필요).
2. **Ansible playbook 과 기존 `AnsiblePlaybookFile`/`Playbook`(`/playbooks` 화면) 과의 관계**: 완전히 흡수(마이그레이션)할지, 당분간 별개로 둘지. 흡수 시 `/playbooks` 화면 자체를 스크립트 라이브러리의 `kind=ansible_playbook` 필터 뷰로 재구성하는 것도 검토 가능(화면 통합 — Batch Jobs 를 홈에 합친 것과 같은 방향).
3. **딥체크/애드온 체커도 "테스트 실행"이 가능해야 하는가**: 요청 #1(모든 동작이 UI 로 확인 가능)을 엄격히 적용하면 기존 체커도 대상 지정 테스트 실행이 필요할 수 있다 — 이미 매트릭스 셀의 "지금 실행"이 사실상 이 역할을 하고 있어 별도 구현 불필요할 가능성이 높다(확인 필요).
4. **권한**: 스크립트 라이브러리 CRUD/테스트 실행을 `require_operator` 로 제한할지, 이 스크립트가 원격 코드 실행이라는 특성상 `require_admin` 까지 올릴지 — 임의 코드 실행 권한이라 후자를 권장.

---

## 9. Test Plan (Phase 0 기준 — 나머지 Phase 는 착수 시 별도 설계 문서에서 구체화)

### 9.1 L2: UI Action Test Scenarios

| # | 컴포넌트 | 액션 | 기대 결과 |
|---|---|---|---|
| 1 | CellButton | hover | ▶ 아이콘 노출(수동 입력 항목은 미노출) |
| 2 | CellButton | ▶ 클릭 | ConfirmDialog 노출, 셀 상세 모달은 안 열림 |
| 3 | ConfirmDialog | 취소 | 아무 실행 없음, 다이얼로그만 닫힘 |
| 4 | ConfirmDialog | 확인 | `useRunCheckMatrixCell` 호출, 완료 토스트, 셀 값 갱신 |

### 9.2 L3: E2E Scenario

| # | 시나리오 | 스텝 | 성공 기준 |
|---|---|---|---|
| 1 | 매트릭스 즉시실행 | 셀 hover → ▶ → 확인 → 완료 대기 | 셀 상태/값이 실행 결과로 갱신, 수행 로그에 manual_cell 트리거로 기록 |

---

## 10. Clean Architecture — Layer Assignment (Phase 0)

| Component | Layer | Location |
|---|---|---|
| `CellButton` 즉시실행 버튼 | Presentation | `frontend/src/components/platform-status/PlatformStatusMatrix.tsx` |
| `ConfirmDialog` 재사용 | Presentation | `frontend/src/components/common/ConfirmDialog.tsx`(기존, 무변경) |
| `useRunCheckMatrixCell` 재사용 | Application | `frontend/src/hooks/useCheckMatrix.ts`(기존, 무변경) |

Phase 1 이후(스크립트 모델)의 레이어 배정은 착수 시 `add-deep-checker`/`backend-feature` 스킬 컨벤션에 맞춰 별도 설계 문서에서 구체화한다.

---

## Version History

| Version | Date | Changes | Author |
|---|---|---|---|
| 0.1 | 2026-08-06 | 최초 작성 — Option A(Strangler Fig) 채택, Phase 0~4 로 분해 | riverjin839 요청 / Claude 작성 |
