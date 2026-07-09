"""릴리즈 노트 — CHANGELOG.md 를 파싱해 프론트 릴리즈 노트 패널에 구조화된 JSON 으로 제공.

CHANGELOG.md 를 유일한 원본(single source of truth)으로 삼아, 사용자가 보는 릴리즈 노트가
항상 실제 릴리즈 내용과 정확히 일치하도록 한다(수동 큐레이션 데이터 사본을 따로 두지 않음).

CHANGELOG.md 는 backend 이미지 빌드 시 build context 로 함께 복사되어야 접근 가능하다
(.github/workflows/cd.yml 의 "Copy CHANGELOG for backend image" 스텝 참고). 파일이 없는
환경(로컬 backend 단독 실행 등)에서는 빈 목록을 반환하고 조용히 넘어간다 — fail-safe.
"""
from __future__ import annotations

import logging
import re
from pathlib import Path

from fastapi import APIRouter

router = APIRouter(prefix="/release-notes", tags=["release-notes"])
logger = logging.getLogger(__name__)

# 이미지 안에서는 backend/CHANGELOG.md (빌드 시 복사됨), 로컬 모노레포 실행에서는
# 저장소 루트의 CHANGELOG.md — 둘 다 시도한다.
_CANDIDATE_PATHS = [
    Path(__file__).resolve().parents[2] / "CHANGELOG.md",       # backend/CHANGELOG.md
    Path(__file__).resolve().parents[3] / "CHANGELOG.md",       # <repo root>/CHANGELOG.md
]

_VERSION_HEADER_RE = re.compile(
    r"^## \[(?P<version>[^\]]+)\](?:\s*-\s*(?P<date>\d{4}-\d{2}-\d{2}))?.*$",
    re.MULTILINE,
)
_SUBSECTION_RE = re.compile(r"^### (?P<name>.+?)\s*$", re.MULTILINE)
_BULLET_RE = re.compile(r"^- (?:\*\*(?P<title>[^*]+)\*\*[:：]?\s*)?(?P<rest>.*)$")


def _find_changelog() -> Path | None:
    for p in _CANDIDATE_PATHS:
        if p.exists():
            return p
    return None


def _parse_bullets(text: str) -> list[dict]:
    """섹션 본문에서 최상위 "- " 불릿만 뽑는다 (하위 들여쓰기 줄은 이전 불릿에 이어붙임)."""
    items: list[dict] = []
    for raw_line in text.splitlines():
        if raw_line.startswith("- "):
            m = _BULLET_RE.match(raw_line)
            if m:
                title = (m.group("title") or "").strip()
                rest = (m.group("rest") or "").strip()
                summary = title or (rest[:60] + ("…" if len(rest) > 60 else ""))
                items.append({"summary": summary, "detail": (rest if title else "").strip()})
            else:
                items.append({"summary": raw_line[2:].strip(), "detail": ""})
        elif raw_line.startswith("  ") and items:
            # 불릿 하위 들여쓰기 줄 — 직전 항목의 detail 에 이어붙임.
            extra = raw_line.strip()
            if extra:
                items[-1]["detail"] = (items[-1]["detail"] + " " + extra).strip()
    return items


def _parse_changelog(text: str) -> list[dict]:
    headers = list(_VERSION_HEADER_RE.finditer(text))
    entries: list[dict] = []
    for i, m in enumerate(headers):
        version = m.group("version")
        if version.lower() == "unreleased":
            continue  # 아직 릴리즈되지 않은 내용은 노출하지 않는다.
        date = m.group("date") or ""
        section_start = m.end()
        section_end = headers[i + 1].start() if i + 1 < len(headers) else len(text)
        section_text = text[section_start:section_end]

        subsections: dict[str, list[dict]] = {}
        sub_headers = list(_SUBSECTION_RE.finditer(section_text))
        for j, sm in enumerate(sub_headers):
            name = sm.group("name")
            body_start = sm.end()
            body_end = sub_headers[j + 1].start() if j + 1 < len(sub_headers) else len(section_text)
            body = section_text[body_start:body_end]
            bullets = _parse_bullets(body)
            if bullets:
                subsections[name] = bullets

        total_items = sum(len(v) for v in subsections.values())
        first_bullet = next(iter(next(iter(subsections.values()), [])), None)
        summary = (first_bullet or {}).get("summary") if first_bullet else None
        if not summary:
            summary = f"{total_items}건 변경" if total_items else "세부 변경 없음"

        entries.append({
            "version": version,
            "date": date,
            "summary": summary,
            "itemCount": total_items,
            "sections": [
                {"name": name, "items": items}
                for name, items in subsections.items()
            ],
        })
    return entries


@router.get("")
def list_release_notes() -> dict:
    path = _find_changelog()
    if path is None:
        logger.warning("release-notes: CHANGELOG.md 를 찾지 못함 (빈 목록 반환)")
        return {"entries": []}
    try:
        text = path.read_text(encoding="utf-8")
        entries = _parse_changelog(text)
    except Exception as e:  # noqa: BLE001 — 파싱 실패해도 500 대신 빈 목록
        logger.warning("release-notes: CHANGELOG.md 파싱 실패 (%s)", e)
        return {"entries": []}
    return {"entries": entries}
