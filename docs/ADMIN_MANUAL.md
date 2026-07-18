# PEP (Platform Engineering Portal) 관리자(Admin) 매뉴얼

> 대상: Kubernetes 운영 담당자 / 플랫폼 관리자
> 목적: 시스템 설치 후 **일상 운영, 점검, 장애 대응, 백업/복구**를 표준화
> 기준 버전: v1.6.0 — 구 제품명 "K8s Daily Monitor / DEVOPS MANAGEMENT" 는 2026-05 PEP 로 재정의 (내부 `app_name` 설정값은 하위호환으로 유지)

---

## 1. 관리자 역할과 책임

PEP 관리자(admin 역할)는 아래 업무를 수행합니다.

- 클러스터 등록/수정/삭제 및 접속 정보(kubeconfig, API endpoint) 관리
- 점검 항목별 cron 스케줄 운영 및 결과 모니터링
- 상태 이상(Warning/Critical) 발생 시 원인 확인 및 조치 추적
- 데이터 백업/복구(내장 JSON export/import) 및 릴리즈(배포) 품질 확인
- 사용자 계정/권한(viewer·operator·admin) 관리, 감사 로그 확인
- 운영 규칙(권한, 점검 기준, 대응 절차) 문서화/지속 개선

---

## 2. 시스템 구성 요약

PEP는 다음 구성요소로 동작합니다.

- **Frontend**: React 기반 운영 대시보드 (NodePort: `30080` 기본)
- **Backend**: FastAPI 기반 API 서버 (NodePort: `30800` 기본)
- **Worker/Scheduler**: Celery Worker + Beat (매분 check-matrix cron 디스패처 + 배치잡/트렌드/리소스 스냅샷 등 6개 스케줄)
- **DB**: PostgreSQL (클러스터/점검/업무/지식/설정 데이터 저장)
- **Cache/Broker**: Redis (비동기 작업 큐)
- **kubewatch**: K8s 이벤트 웹훅 수집 · **grafana-renderer**: 패널 이미지 렌더링 (둘 다 선택 구성)

운영자는 최소한 다음 URL 동작을 확인해야 합니다.

- 대시보드: `http://<접속IP>:30080`
- Backend Health: `http://<접속IP>:30800/health`
- Swagger: `http://<접속IP>:30800/docs`

---

## 3. 최초 운영 시작 체크리스트

### 3.1 배포 상태 확인

```bash
kubectl get pods -n k8s-monitor
kubectl get svc -n k8s-monitor
kubectl get ingress -n k8s-monitor  # ingress 사용 시
```

확인 포인트:

- backend / frontend / celery-worker / celery-beat / postgres / redis Pod가 `Running`
- 재시작 횟수(`RESTARTS`)가 비정상적으로 증가하지 않음
- NodePort 또는 Ingress 경로가 사내망에서 접근 가능

### 3.2 API 준비 상태 확인

```bash
curl -sS http://<접속IP>:30800/health
curl -sS http://<접속IP>:30800/health/ready
```

- HTTP 200 응답 확인
- 실패 시 Backend 로그를 우선 점검

```bash
kubectl logs deploy/backend -n k8s-monitor --tail=200   # prod 오버레이는 deploy/prod-backend
```

### 3.3 기본 데이터/설정 확인

- 대시보드 접속 후 클러스터 목록 페이지 로딩
- **Settings 메뉴(관리자 계정만 접근 가능)** 에서 운영 레벨/클러스터/관리서버/백업·복구/감사 로그 등 관리 항목 확인
- 점검 결과 히스토리 조회가 정상 작동하는지 확인

---

## 4. 일상 운영(Standard Runbook)

### 4.1 클러스터 등록/수정/삭제

클러스터 **등록**은 클러스터 관리 화면이 아니라 **Settings → 클러스터 탭**에서 한다
(`ClusterManagePage`는 조회·자동수집·편집 전용).

1. Settings → 클러스터 탭 → "클러스터 추가" — 3단계 마법사(환경 선택 → 기본 정보 →
   Kubeconfig)로 진행. Provider(On-Prem/EKS/GKE/AKS/Rancher/kind·k3s/OpenShift) 선택
2. 클러스터명, API Endpoint, kubeconfig 정보 입력 — kubeconfig 가 아직 없으면
   "임시 가등록"(연결 미검증)으로 먼저 저장 가능
3. 저장 시 자동 연결검증(최대 수 초) → 결과가 `Healthy`인지 확인 후 운영 대상 포함
4. 클러스터명 규칙: **`[업무명]-[운영타입]-[속성]`** (운영타입: prod/dev/test/stage,
   region 은 별도 필드) — Settings 의 "이름 표준화" 도구로 기존 클러스터 일괄 정리 가능

운영 권장사항:

- kubeconfig는 최소 권한 원칙(RBAC read 중심)
- 테스트/임시 클러스터는 운영타입을 `test`/`dev` 로 명확히 구분

### 4.2 점검 스케줄 운영 (check-matrix cron)

구 아침/점심/저녁 3회 고정 스케줄은 **check-matrix cron 디스패처로 완전 대체**됐다.
Celery Beat 가 **매분** 아래 두 스케줄 단위를 평가해 due 한 점검을 실행한다.

- **core 번들**: 클러스터별 `Cluster.check_cron_expr` (일일 API/노드/시스템파드 점검)
- **개별 항목**: `CheckMatrixSchedule` (점검 항목 × 클러스터, 항목별 cron_expr + enabled)

점검 항목 자체의 추가/활성화는 **"점검 항목 관리"(`/daily-check/settings`)** 에서,
일괄/개별 수동 실행은 **"운영 점검 콘솔"(`/ops-checks`)** 에서 한다.

운영자는 월 1회 이상 아래를 확인합니다.

- 각 클러스터/점검 항목의 cron_expr 및 `enabled` 상태
- 최근 `last_run_at` 기준 최근 7일 동안 점검 누락(실행 기록 없음)이 없는지
- Celery Beat(디스패처) Pod 가 정상 동작 중인지 (§5.3)

### 4.3 점검 결과 확인 기준

대시보드에서 각 클러스터 상태를 다음 기준으로 분류합니다.

- **Healthy(정상)**: API/컴포넌트/노드/시스템 파드 모두 정상 범위
- **Warning(주의)**: 일부 지표 지연/부분 실패
- **Critical(위험)**: 핵심 경로(API, control-plane, node 상태) 장애
- **미연결(pending)**: 아직 연결 확인 전이거나 연결 검증에 실패한 상태(critical 과 구분)

Warning 이상 발생 시:

1. 최신 점검 상세(에러 메시지, 실패 항목) 확인
2. 동일 시간대의 Kubernetes 이벤트/Pod 상태/노드 상태 확인
3. 조치 내용(원인, 대응, 재발 방지)을 운영 메모 또는 티켓에 기록

---

## 5. 장애 대응 가이드

### 5.1 공통 1차 점검

```bash
kubectl get pods -n k8s-monitor
kubectl get events -n k8s-monitor --sort-by=.lastTimestamp | tail -n 30
kubectl top pods -n k8s-monitor  # metrics-server 설치 시
```

체크 항목:

- CrashLoopBackOff / ImagePullBackOff 여부
- DB/Redis 연결 실패 로그 여부
- CPU/MEM 포화로 인한 응답 지연 여부

### 5.2 Backend 장애

```bash
kubectl logs deploy/backend -n k8s-monitor --tail=300
kubectl describe pod -n k8s-monitor -l app.kubernetes.io/name=backend
```

주요 원인:

- DB 접속 실패(비밀번호/호스트/네트워크)
- 잘못된 환경변수(SECRET_KEY, CORS, API URL)
- 신규 배포 이후 마이그레이션 불일치

### 5.3 Worker(스케줄) 장애

```bash
kubectl logs deploy/celery-worker -n k8s-monitor --tail=300
kubectl logs deploy/celery-beat -n k8s-monitor --tail=300
```

주요 원인:

- Redis broker 연결 실패
- 큐 적체(작업은 쌓이지만 처리 지연)
- 특정 클러스터 점검 작업의 장시간 timeout

### 5.4 복구 우선순위

1. 사용자 화면(Frontend) 접근성 복구
2. API 응답 복구(Backend health)
3. 정기 점검 파이프라인(Worker/Beat) 복구
4. 누락 점검에 대한 수동 재실행 및 이력 보정

---

## 6. 백업/복구 운영

### 6.0 내장 백업/복구 (권장 — 우선 사용)

**Settings → 백업/복구 탭**에서 애플리케이션 자체 JSON 백업/복구를 제공한다 (관리자 전용,
모든 export/import 는 감사 로그에 기록됨).

- **Export**: `GET /backup/export` — `include_logs`(로그성 테이블 포함 여부),
  `include_sensitive`(kubeconfig 등 민감 필드 포함 여부, 기본 마스킹) 옵션
- **복구 미리보기**: `POST /backup/import/preview` — 실제 반영 전 변경 diff 확인 (dry-run)
- **Import**: `POST /backup/import` — `merge`(누락분만 반영) 또는 `replace`(전체 교체,
  `confirm=true` 필수) 모드
- Export/복구 결과의 `errors`/`skipped_tables` 를 확인해 스키마 드리프트를 조기에 파악

PostgreSQL 레벨 백업(§6.1~6.3)은 재해복구용 보조 수단으로 병행한다. 상세 절차는
[BACKUP_RESTORE_GUIDE.md](BACKUP_RESTORE_GUIDE.md) 참고.

### 6.1 PostgreSQL 백업 범위

- PostgreSQL: 클러스터 메타정보, 점검 이력, 게시판/설정 데이터
- (필요 시) 첨부/정적 파일 저장소
- 배포 매니페스트(values, kustomize overlay), 시크릿 관리 기록

### 6.2 권장 백업 주기

- DB 전체 백업: 일 1회(야간)
- 트랜잭션 중요 환경: 4~6시간 단위 증분/스냅샷
- 백업 보관: 7일(단기) + 4주(주간) + 3개월(월간)

### 6.3 복구 훈련(Drill)

월 1회 이상 아래를 검증합니다.

1. 특정 날짜 백업에서 복원 가능한지
2. 복원 후 대시보드 주요 기능(조회/등록/점검 실행)이 동작하는지
3. 복구 소요 시간(RTO)과 데이터 손실 범위(RPO)가 목표 이내인지

---

## 7. 배포/업그레이드 운영

### 7.1 배포 전 점검

- 릴리즈 노트 확인(스키마/환경변수 변경 유무)
- 운영 중 점검 배치 시간대와 충돌 없는지 확인
- 롤백 가능한 이전 이미지 태그 확보

### 7.2 배포 후 검증 (10~15분)

```bash
kubectl rollout status deploy/backend -n k8s-monitor
kubectl rollout status deploy/frontend -n k8s-monitor
kubectl get pods -n k8s-monitor
```

기능 검증:

- 대시보드 접속 및 로그인 (**인증은 항상 필수** — 최초 부팅 시 bootstrap admin 계정
  `admin`/`admin` 이 자동 생성되며, 배포 직후 반드시 비밀번호를 변경할 것)
- 클러스터 목록 조회
- 수동 점검 실행 1회
- 최근 점검 결과 카드 렌더링

### 7.3 롤백 기준

아래 중 하나라도 충족하면 즉시 롤백을 검토합니다.

- 5분 이상 핵심 API 응답 실패 지속
- `Critical` 비율이 배포 직후 급증(배포 전 대비)
- 데이터 저장/조회 장애 재현

---

## 8. 보안/권한 운영 수칙

### 8.1 애플리케이션 계정/권한

- 역할 3종: **viewer**(조회) / **operator**(운영 조작) / **admin**(전체 관리) —
  Settings → 사용자 관리(`/settings/users`, admin 전용)에서 생성·삭제·역할변경·비밀번호 초기화
- Settings·사용자관리·백업/복구·감사 로그는 **admin 만 접근 가능**
- 최초 admin 계정(`admin`/`admin`)은 배포 직후 반드시 비밀번호 변경
- 화면/기능 단위 접근 제어(Feature Access)는 Settings → 접근 제어 탭에서 검토

### 8.2 인프라 권한

- kubeconfig 및 DB 비밀번호는 Git에 커밋 금지
- 운영 계정과 개발 계정 분리, 공용 계정 사용 금지
- K8s RBAC 최소 권한 원칙 적용(읽기/진단 권한 우선)
- NodePort 직접 노출 시 사내 ACL/IP 제한 적용
- 정기적으로 Secret 로테이션(분기 1회 권장)

---

## 8.5 관리자가 자주 쓰는 그 외 화면 (Settings 하위)

| 기능 | 위치 | 설명 |
|---|---|---|
| 사용자 관리 | `/settings/users` (admin) | 계정 생성/삭제/역할변경/비밀번호 초기화 |
| 감사 로그 | Settings → 감사 로그 탭 | 로그인 성공/실패, 사용자 변경, 백업 import 등 이력 |
| 점검 항목 관리 | `/daily-check/settings` | Deep Check 정의 CRUD(클러스터별) + 알림 설정 |
| 운영 점검 콘솔 | `/ops-checks` | 점검 항목 선택 일괄/개별 실행, 진행률/로그 |
| Batch Jobs | `/batch-jobs` | cron 기반 원격 명령 실행(무인, 저장 자격증명 필요) |
| 관리서버(Bastion) | Settings → 관리서버 탭 | Jump host 등록 및 핑 체크 |
| 기능 접근 제어 | Settings → 접근 제어 탭 | 화면/기능 단위 노출 제어(예: `/wbs`) |
| VOC 게시판 관리자 답변 | 사이드바 VOC 아이콘 | admin/operator 만 답변·상태 변경 가능, 답변 시 작성자 알림 |
| 알림 채널 설정 | `config.py` `SLACK_WEBHOOK_URL`/`SMTP_*` | Slack/이메일 알림 fan-out (환경변수, CLAUDE.md 참고) |

자동 실행되는 백그라운드 스케줄(참고용, 별도 조작 불필요): 기술 트렌드 수집(매일
07:00), 리소스 카운트 스냅샷(운영자 cron), 점검 결과 로그 정리(매일 03:00),
클러스터 아이템 점검(매시 정각) — 모두 Celery Beat 가 관리한다 (§2, CLAUDE.md
"Celery Tasks" 참고).

---

## 9. 점검 누락/오탐 최소화를 위한 운영 팁

- 점검 실패 시 1회 재시도로 네트워크 일시 장애를 분리
- 유지보수 창(Planned maintenance)에는 알림 노이즈 억제 정책 적용
- 클러스터별 임계값(노드 수, 시스템 파드 기준)을 현실적으로 조정
- 운영 메모/태스크 보드와 연계해 원인-조치-결과를 남기기

---

## 10. 운영 체크리스트 (주간/월간)

### 주간

- [ ] Warning/Critical 상위 클러스터 원인 분류 완료
- [ ] 누락 점검 건 재실행/사유 기록 완료
- [ ] 장애 대응 티켓 후속 조치 상태 확인

### 월간

- [ ] 백업 복구 훈련 1회 완료
- [ ] 스케줄/시간대/권한 정책 재검토
- [ ] 사용하지 않는 클러스터/계정/시크릿 정리
- [ ] 운영 지표(가용성, MTTR, 오탐율) 리포트 공유

---

## 부록 A. 운영자가 자주 쓰는 명령어

```bash
# 네임스페이스 전체 상태
kubectl get all -n k8s-monitor

# 최근 이벤트
kubectl get events -n k8s-monitor --sort-by=.lastTimestamp | tail -n 50

# 백엔드/워커 로그
kubectl logs deploy/backend -n k8s-monitor --tail=200
kubectl logs deploy/celery-worker -n k8s-monitor --tail=200
kubectl logs deploy/celery-beat -n k8s-monitor --tail=200

# 서비스 접근 정보
kubectl get svc -n k8s-monitor -o wide
```

## 부록 B. 문서 버전 관리

- 문서명: `docs/ADMIN_MANUAL.md`
- 권장 업데이트 주기: 기능 릴리즈 직후 또는 월 1회
- 변경 이력은 Git 커밋 메시지에 `docs(admin): ...` 형식으로 기록
