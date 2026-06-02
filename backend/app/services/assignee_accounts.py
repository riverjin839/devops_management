"""담당자(assignees) → 로그인 계정 자동 provisioning.

담당자 관리(Settings ▸ 담당자 탭)에 사번(employeeId)과 함께 등록된 담당자는
자동으로 DB User 계정을 부여받는다:

  - username       = 사번 (employeeId)
  - 초기 비밀번호  = 사번 (employeeId)  ← 로그인 후 본인이 변경
  - role           = operator
  - display_name   = 담당자 이름

설계 원칙 (codebase 의 fail-safe 관례를 따른다):
  * **멱등** — 이미 같은 username(=사번) 의 User 가 있으면 건드리지 않는다.
    (비밀번호/역할을 보존: 운영자가 admin 으로 승격했거나 비밀번호를 바꿨을 수 있다.)
  * **사번 없는 담당자는 skip** — 로그인 키가 없어 계정을 만들 수 없다.
  * **per-user commit + try/except** — 한 계정 생성이 실패(예: username race)해도
    다른 계정 생성은 계속 진행한다.

NOTE: User 모델의 ``must_change_password`` 는 부팅 마이그레이션이 매번 FALSE 로
강제 해제하므로(강제 변경 정책 폐기) 여기서도 설정하지 않는다 — 초기 비밀번호는
사번이며, 사용자가 /settings 에서 자발적으로 변경한다.
"""
import logging

from sqlalchemy.orm import Session

from app.models.user import User
from app.auth.security import hash_password

_log = logging.getLogger("k8s_monitor.assignee_accounts")

# 담당자 계정에 부여하는 기본 권한.
ASSIGNEE_ACCOUNT_ROLE = "operator"


def _employee_id(assignee: dict) -> str:
    """assignee dict 에서 사번을 정규화해 추출. 없으면 빈 문자열."""
    raw = assignee.get("employeeId") or assignee.get("employee_id")
    return str(raw).strip() if raw is not None else ""


def sync_assignee_accounts(db: Session, assignees: list) -> dict:
    """등록된 담당자 목록에 대해 operator 로그인 계정을 보강한다.

    Args:
        db: 활성 SQLAlchemy 세션.
        assignees: 정규화된 assignee dict 리스트 (``_normalize_assignee`` 출력 형태).

    Returns:
        요약 dict — ``created`` / ``skipped_existing`` / ``skipped_no_employee_id`` /
        ``errors`` (각각 사번 또는 이름 리스트). 운영자가 결과를 확인할 수 있도록
        라우터 응답에 그대로 실어 보낸다.
    """
    created: list[str] = []
    skipped_existing: list[str] = []
    skipped_no_employee_id: list[str] = []
    errors: list[str] = []

    if not isinstance(assignees, list):
        return {
            "created": created,
            "skipped_existing": skipped_existing,
            "skipped_no_employee_id": skipped_no_employee_id,
            "errors": errors,
        }

    # 기존 username 을 한 번에 적재 — 담당자마다 SELECT 하는 N+1 회피.
    try:
        existing_usernames = {row[0] for row in db.query(User.username).all()}
    except Exception as e:  # noqa: BLE001
        _log.warning("assignee account sync: failed to load existing users (%s)", e)
        existing_usernames = set()

    seen: set[str] = set()
    for a in assignees:
        if not isinstance(a, dict):
            continue
        emp = _employee_id(a)
        name = str(a.get("name", "")).strip()
        if not emp:
            if name:
                skipped_no_employee_id.append(name)
            continue
        if emp in seen:
            continue
        seen.add(emp)
        if emp in existing_usernames:
            skipped_existing.append(emp)
            continue

        user = User(
            username=emp,
            hashed_password=hash_password(emp),
            role=ASSIGNEE_ACCOUNT_ROLE,
            display_name=name or emp,
        )
        db.add(user)
        try:
            db.commit()
            created.append(emp)
            existing_usernames.add(emp)
            _log.info("assignee account created: 사번=%s name=%s role=%s", emp, name, ASSIGNEE_ACCOUNT_ROLE)
        except Exception as e:  # noqa: BLE001
            db.rollback()
            errors.append(emp)
            _log.warning("assignee account create failed for 사번=%s (%s) — continuing", emp, e)

    return {
        "created": created,
        "skipped_existing": skipped_existing,
        "skipped_no_employee_id": skipped_no_employee_id,
        "errors": errors,
    }
