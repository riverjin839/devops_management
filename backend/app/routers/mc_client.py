"""MinIO mc client 원격 실행 + 프리셋 관리.

etcdctl 과 비슷한 패턴: 특정 호스트에 SSH 로 접속 후 mc 명령 실행.
기본값으로 alias 가 이미 설정돼 있다고 가정(`mc alias set` 은 여기서
직접 별도로 수행). 필요하면 extra_env 로 MC_CONFIG_DIR 등 지정 가능.

프리셋은 3계층으로 병합된다:
  1. builtin  — 아래 BUILTIN_PRESETS (코드 기본값).
  2. shared   — admin 이 배포한 공용 프리셋 (app_settings 의 ``mc_presets_shared``).
  3. personal — 사용자 개인 커스텀/오버라이드/숨김 (user_settings 의 ``mc_presets``).
개인 설정이 공용·기본을 덮어쓰며, hidden 으로 기본/공용 프리셋을 개인적으로 숨길 수 있다.
"""
import shlex
import time
from typing import Literal, Optional
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Cluster
from app.models.app_setting import AppSetting
from app.models.user import User
from app.auth.deps import get_current_user, require_admin, require_operator
from app.services.ssh_runner import SSHTarget, run_bulk
from app.services.user_settings import get_user_setting, set_user_setting

router = APIRouter(tags=["mc"])


# ── 프리셋 ───────────────────────────────────────────────────────────────────

BUILTIN_PRESETS: dict[str, dict[str, str]] = {
    "alias-list":    {"label": "alias 목록",            "args": "alias list"},
    "admin-info":    {"label": "admin info (서버 상태)", "args": "admin info {alias}"},
    "ls":            {"label": "버킷 목록 (ls)",         "args": "ls {alias}"},
    "du":            {"label": "용량 (du)",              "args": "du {alias} --depth 1"},
    "admin-user-list": {"label": "사용자 목록",          "args": "admin user list {alias}"},
    "admin-policy-list": {"label": "정책 목록",          "args": "admin policy list {alias}"},
    "admin-heal-status": {"label": "Heal 상태",          "args": "admin heal {alias} --dry-run --recursive"},
    "admin-service-status": {"label": "서비스 상태",     "args": "admin service status {alias}"},
    "admin-config-history": {"label": "설정 이력",       "args": "admin config history {alias} --limit 10"},
    "version":       {"label": "mc 버전 확인",           "args": "--version"},
}

PERSONAL_KEY = "mc_presets"
SHARED_KEY = "mc_presets_shared"


# ── schemas ──────────────────────────────────────────────────────────────────

class McRequest(BaseModel):
    host: str = Field(..., description="mc 가 설치된 호스트 (master 혹은 bastion)")
    port: int = 22
    username: str = "root"
    password: Optional[str] = None
    private_key: Optional[str] = None

    args: str = Field(..., description="mc 에 붙일 인자. {alias} placeholder 사용 가능.")
    alias: str = Field(default="local", description="{alias} 를 대체할 값")
    mc_path: str = Field(default="mc", description="mc 바이너리 경로 (PATH 상이면 'mc')")
    extra_env: dict[str, str] = Field(default_factory=dict)
    timeout: int = Field(default=60, ge=1, le=600)


class McResponse(BaseModel):
    host: str
    status: Literal["ok", "error", "timeout", "auth_error", "connect_error"]
    exit_code: Optional[int] = None
    stdout: str = ""
    stderr: str = ""
    duration_ms: int = 0
    error: Optional[str] = None
    executed_command: str = ""


class McPresetItem(BaseModel):
    key: str = Field(..., min_length=1, max_length=64)
    label: str = Field(..., min_length=1, max_length=120)
    args: str = Field(..., min_length=1, max_length=2000)


class PersonalPresetsPayload(BaseModel):
    """사용자 개인 프리셋 설정 전체(통째로 PUT)."""
    custom: list[McPresetItem] = Field(default_factory=list)
    overrides: dict[str, McPresetItem] = Field(default_factory=dict)
    hidden: list[str] = Field(default_factory=list)


class SharedPresetsPayload(BaseModel):
    presets: list[McPresetItem] = Field(default_factory=list)


# ── preset helpers ───────────────────────────────────────────────────────────

def _read_shared(db: Session) -> list[dict]:
    row = db.query(AppSetting).filter(AppSetting.key == SHARED_KEY).first()
    value = (row.value if row else None) or {}
    presets = value.get("presets") if isinstance(value, dict) else None
    out: list[dict] = []
    if isinstance(presets, list):
        for p in presets:
            if isinstance(p, dict) and p.get("key") and p.get("args"):
                out.append({"key": str(p["key"]), "label": str(p.get("label") or p["key"]), "args": str(p["args"])})
    return out


def _read_personal(db: Session, user_id: str) -> dict:
    raw = get_user_setting(db, user_id, PERSONAL_KEY, {}) or {}
    if not isinstance(raw, dict):
        return {"custom": [], "overrides": {}, "hidden": []}
    custom = [c for c in raw.get("custom", []) if isinstance(c, dict) and c.get("key") and c.get("args")]
    overrides = raw.get("overrides", {}) if isinstance(raw.get("overrides"), dict) else {}
    hidden = [str(h) for h in raw.get("hidden", []) if isinstance(h, (str,))]
    return {"custom": custom, "overrides": overrides, "hidden": hidden}


def _effective_presets(db: Session, user_id: str) -> list[dict]:
    merged: dict[str, dict] = {}
    for k, v in BUILTIN_PRESETS.items():
        merged[k] = {"key": k, "label": v["label"], "args": v["args"], "source": "builtin"}
    for p in _read_shared(db):
        merged[p["key"]] = {"key": p["key"], "label": p["label"], "args": p["args"], "source": "shared"}

    personal = _read_personal(db, user_id)
    for c in personal["custom"]:
        merged[str(c["key"])] = {
            "key": str(c["key"]), "label": str(c.get("label") or c["key"]),
            "args": str(c["args"]), "source": "personal",
        }
    # overrides: 기존(기본/공용/커스텀) 항목의 label/args 를 개인적으로 수정.
    for k, ov in personal["overrides"].items():
        if not isinstance(ov, dict):
            continue
        base = merged.get(k, {"key": k, "source": "personal"})
        merged[k] = {
            "key": k,
            "label": str(ov.get("label") or base.get("label") or k),
            "args": str(ov.get("args") or base.get("args") or ""),
            "source": base.get("source", "personal"),
            "customized": True,
        }
    for h in personal["hidden"]:
        merged.pop(h, None)

    out = []
    for entry in merged.values():
        if not entry.get("args"):
            continue
        out.append({
            "key": entry["key"],
            "label": entry["label"],
            "args": entry["args"],
            "source": entry.get("source", "builtin"),
            "customized": bool(entry.get("customized", False)),
        })
    return out


# ── preset endpoints ─────────────────────────────────────────────────────────

@router.get("/clusters/{cluster_id}/mc/presets")
def list_presets(cluster_id: UUID, db: Session = Depends(get_db),
                 user: User = Depends(get_current_user)):
    # cluster_id 는 URL 패턴 일관성을 위한 용도 (검증 목적)
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")
    return {"presets": _effective_presets(db, user.id)}


@router.get("/mc/presets/personal")
def get_personal_presets(db: Session = Depends(get_db),
                         user: User = Depends(get_current_user)):
    return _read_personal(db, user.id)


@router.put("/mc/presets/personal")
def update_personal_presets(payload: PersonalPresetsPayload, db: Session = Depends(get_db),
                            user: User = Depends(get_current_user)):
    value = {
        "custom": [c.model_dump() for c in payload.custom],
        "overrides": {k: v.model_dump() for k, v in payload.overrides.items()},
        "hidden": list(dict.fromkeys(payload.hidden)),
    }
    set_user_setting(db, user.id, PERSONAL_KEY, value)
    return value


@router.get("/mc/presets/shared")
def get_shared_presets(db: Session = Depends(get_db),
                       _: User = Depends(get_current_user)):
    return {"presets": _read_shared(db)}


@router.put("/mc/presets/shared")
def update_shared_presets(payload: SharedPresetsPayload, db: Session = Depends(get_db),
                          _: User = Depends(require_admin)):
    """공용 프리셋 배포 — admin 전용. 사용자에게 'shared' 출처로 보인다."""
    # key 중복 제거(먼저 들어온 항목 우선)
    seen: set[str] = set()
    cleaned: list[dict] = []
    for p in payload.presets:
        if p.key in seen:
            continue
        seen.add(p.key)
        cleaned.append(p.model_dump())
    row = db.query(AppSetting).filter(AppSetting.key == SHARED_KEY).first()
    if row is None:
        row = AppSetting(key=SHARED_KEY, value={"presets": cleaned})
        db.add(row)
    else:
        row.value = {"presets": cleaned}
    db.commit()
    return {"presets": cleaned}


# ── run endpoint ─────────────────────────────────────────────────────────────

def _build_mc_command(req: McRequest) -> str:
    parts: list[str] = []
    for k, v in (req.extra_env or {}).items():
        if not k.replace("_", "").isalnum():
            continue
        parts.append(f"export {k}={shlex.quote(v)}")
    # {alias} placeholder 치환
    args = req.args.replace("{alias}", req.alias)
    parts.append(f"{shlex.quote(req.mc_path)} {args}")
    return " && ".join(parts) if len(parts) > 1 else parts[0]


@router.post("/clusters/{cluster_id}/mc/run", response_model=McResponse)
async def run_mc(
    cluster_id: UUID,
    payload: McRequest,
    db: Session = Depends(get_db),
    _: User = Depends(require_operator),
):
    """SSH 접속 후 mc 명령 실행."""
    if not payload.password and not payload.private_key:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="password 또는 private_key 중 하나는 필수입니다.",
        )
    if not payload.args.strip():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="args 는 비어있을 수 없습니다.",
        )
    cluster = db.query(Cluster).filter(Cluster.id == cluster_id).first()
    if not cluster:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Cluster not found")

    bash_cmd = _build_mc_command(payload)
    remote_cmd = f"bash -lc {shlex.quote(bash_cmd)}"

    target = SSHTarget(
        host=payload.host, port=payload.port, username=payload.username,
        password=payload.password, private_key=payload.private_key,
    )
    start = time.monotonic()
    results = await run_bulk(
        [target],
        action="ssh",
        command=remote_cmd,
        mode="sequential",
        connect_timeout=min(payload.timeout, 10),
        exec_timeout=payload.timeout,
        parallelism=1,
    )
    r = results[0]
    _ = start
    return McResponse(
        host=r.host, status=r.status, exit_code=r.exit_code,
        stdout=r.stdout, stderr=r.stderr, duration_ms=r.duration_ms,
        error=r.error, executed_command=bash_cmd,
    )
