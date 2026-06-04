# 보안 정책 (SECURITY)

## 취약점 신고
보안 취약점은 **공개 이슈로 올리지 말고** 메인테이너에게 비공개로 보고한다
(내부 보안 채널 / 저장소 관리자). 재현 절차·영향 범위를 포함해 주세요.

## 설계상 보안 원칙
- **인증**: 모든 보호 API 는 JWT 필요. 역할 viewer/operator/admin (`auth/deps.py`).
- **K8s 제어 범위**: 현재 **읽기 위주**. 리소스 탐색/로그는 읽기전용이며 YAML 편집/apply 는
  보류(향후 도입 시 **admin 전용 + server dry-run + 감사**). 대상 클러스터는 read-only ServiceAccount 권장.
- **자격증명**: SSH/비밀번호/키는 평문 DB 저장 금지 — `services/secret_box.py`(Fernet) 로 암호화,
  실행 시 복호화. 휘발성 자격증명은 세션/요청 범위로만 전달.
- **민감 데이터**: 리소스 YAML 조회 시 Secret 의 `data` 값은 마스킹. 백업 export 는
  `SENSITIVE_COLUMNS` 마스킹 옵션 제공.
- **감사 로그**: 주요 작업(로그인/사용자·클러스터 변경/플레이북 실행/백업 등) `audit_logs` 기록.
- **시크릿 관리**: `.env` 는 커밋 금지(`.gitignore`). 운영 시크릿은 K8s Secret/외부 비밀관리로.

## 지원 버전
현재 `main`(최신 릴리스, [CHANGELOG](CHANGELOG.md)) 만 보안 패치 대상.
