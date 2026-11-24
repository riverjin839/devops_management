"""공통 서비스 수집기 — 배포 수준(K8S 워크로드 · Podman 컨테이너) + 앱 설정(서비스별 API).

모든 수집기는 ``Ctx`` 를 받아 ``ctx.add(component, data)`` 로 결과를 남기고, 실패는 예외로 올린다 — 단계 실패 기록·계속 진행은
``service.run_collect`` 가 단계마다 잡아서 한다(fail-safe: 한 단계 실패가 다른 단계를 막지 않고, HTTP 500 을 만들지 않는다).
노드·서비스 설정은 바꾸지 않는다(읽기 전용 호출만).
"""
from __future__ import annotations

import json
import shlex
from dataclasses import dataclass, field
from typing import Any, Callable, Optional

from app.services.common_services import flatten as F

HTTP_TIMEOUT = 15
SSH_TIMEOUT = 30


class CollectError(Exception):
    """운영자에게 그대로 보여줄 사유."""


@dataclass
class Ctx:
    inst: Any
    params: dict[str, Any]
    creds: dict[str, Any]                         # purpose → {username, secret, auth_type}
    cluster: Any = None
    log: Callable[[str, str], None] = lambda level, msg: None
    components: dict[str, dict[str, Any]] = field(default_factory=dict)
    _apis: Any = None

    def add(self, component: str, data: Any, meta: Optional[dict[str, Any]] = None) -> int:
        flat = F.flatten(data)
        self.components[component] = {"flat": flat, "meta": meta or {}}
        self.log("info", f"{component}: 설정 {len(flat)}개")
        return len(flat)

    # ── K8S ──
    def k8s(self):
        if self._apis is None:
            if self.cluster is None:
                raise CollectError("호스팅 클러스터가 지정되지 않았습니다.")
            from app.services.service_config.apply import k8s_apis

            self._apis = k8s_apis(self.cluster)
        return self._apis

    # ── HTTP ──
    def base_url(self) -> str:
        url = (self.inst.endpoint_url or "").strip().rstrip("/")
        if not url:
            raise CollectError("엔드포인트 주소가 비어 있습니다(인스턴스 편집에서 입력).")
        return url

    def http(self):
        import httpx

        return httpx.Client(verify=bool(self.inst.tls_verify), timeout=HTTP_TIMEOUT, follow_redirects=True)

    # ── SSH ──
    def ssh(self, command: str, max_chars: int = 200_000) -> str:
        from app.services.ssh_runner import SSHTarget, _exec_ssh

        cred = self.creds.get("ssh") or {}
        host = (self.inst.ssh_host or "").strip()
        if not host:
            raise CollectError("SSH 호스트가 비어 있습니다.")
        secret = cred.get("secret")
        if not secret:
            raise CollectError("SSH 자격증명이 등록되지 않았습니다(인스턴스 편집 ▸ 자격증명).")
        is_key = cred.get("auth_type") == "private_key"
        tgt = SSHTarget(host=host, port=int(self.inst.ssh_port or 22), username=cred.get("username") or "root",
                        password=None if is_key else secret, private_key=secret if is_key else None, name=self.inst.name)
        self.log("info", f"SSH {tgt.username}@{host}:{tgt.port} $ {command}")
        res = _exec_ssh(tgt, command, connect_timeout=8, exec_timeout=SSH_TIMEOUT, max_stdout_chars=max_chars)
        if res.status != "ok" or (res.exit_code not in (0, None)):
            raise CollectError(f"SSH 명령 실패({res.status}, exit={res.exit_code}): {(res.error or res.stderr or '')[:300]}")
        return res.stdout


def _get_json(ctx: Ctx, client: Any, path: str, **kw) -> Any:
    url = ctx.base_url() + path
    ctx.log("info", f"GET {url}")
    r = client.get(url, **kw)
    if r.status_code in (401, 403):
        raise CollectError(f"{path}: 인증 실패({r.status_code}) — 자격증명·권한을 확인하세요.")
    if r.status_code >= 400:
        raise CollectError(f"{path}: HTTP {r.status_code}")
    return r.json()


def _basic(ctx: Ctx) -> Optional[tuple[str, str]]:
    c = ctx.creds.get("app_api") or {}
    return (c.get("username") or "", c.get("secret")) if c.get("secret") else None


# ── 배포 수준: K8S 워크로드 ─────────────────────────────────────────────────

def _env_of(container: Any) -> dict[str, Any]:
    out: dict[str, Any] = {}
    for e in getattr(container, "env", None) or []:
        vf = getattr(e, "value_from", None)
        if vf is not None:
            sk = getattr(vf, "secret_key_ref", None)
            ck = getattr(vf, "config_map_key_ref", None)
            fr = getattr(vf, "field_ref", None)
            if sk is not None:
                out[e.name] = f"secret:{sk.name}/{sk.key}"
            elif ck is not None:
                out[e.name] = f"configmap:{ck.name}/{ck.key}"
            elif fr is not None:
                out[e.name] = f"field:{fr.field_path}"
            else:
                out[e.name] = "(valueFrom)"
        else:
            out[e.name] = e.value
    return F.mask_env(out)


def read_workload(ctx: Ctx) -> Any:
    inst = ctx.inst
    if not (inst.namespace and inst.workload_name):
        raise CollectError("네임스페이스·워크로드 이름이 비어 있습니다.")
    _core, apps = ctx.k8s()
    kind = (inst.workload_kind or "Deployment").lower()
    reader = {"deployment": apps.read_namespaced_deployment, "statefulset": apps.read_namespaced_stateful_set,
              "daemonset": apps.read_namespaced_daemon_set}.get(kind)
    if reader is None:
        raise CollectError(f"지원하지 않는 워크로드 종류: {inst.workload_kind}")
    ctx.log("info", f"K8S {inst.workload_kind} {inst.namespace}/{inst.workload_name} 조회")
    return reader(inst.workload_name, inst.namespace, _request_timeout=15)


def collect_k8s_deploy(ctx: Ctx) -> None:
    from app.services.service_config.collect import container_flags

    wl = read_workload(ctx)
    spec = wl.spec
    pod = spec.template.spec
    data: dict[str, Any] = {"kind": ctx.inst.workload_kind, "replicas": getattr(spec, "replicas", None),
                            "serviceAccount": getattr(pod, "service_account_name", None), "containers": []}
    cms: list[str] = []
    for c in list(getattr(pod, "init_containers", None) or []) + list(pod.containers or []):
        res = getattr(c, "resources", None)
        data["containers"].append({
            "name": c.name, "image": c.image, "args": container_flags(c) or None, "env": _env_of(c) or None,
            "resources": {"requests": getattr(res, "requests", None), "limits": getattr(res, "limits", None)} if res else None,
            "ports": [f"{p.container_port}/{p.protocol or 'TCP'}" for p in (c.ports or [])] or None,
        })
        for ef in getattr(c, "env_from", None) or []:
            if getattr(ef, "config_map_ref", None) is not None:
                cms.append(ef.config_map_ref.name)
    for v in getattr(pod, "volumes", None) or []:
        if getattr(v, "config_map", None) is not None:
            cms.append(v.config_map.name)
    ctx.add("deploy", data, {"image": (pod.containers or [None])[0].image if pod.containers else None})
    core, _apps = ctx.k8s()
    for name in dict.fromkeys(cms):
        read_configmap(ctx, core, name)


def read_configmap(ctx: Ctx, core: Any, name: str) -> None:
    if f"configmap:{name}" in ctx.components:
        return
    ctx.log("info", f"K8S ConfigMap {ctx.inst.namespace}/{name} 조회")
    cm = core.read_namespaced_config_map(name, ctx.inst.namespace, _request_timeout=15)
    ctx.add(f"configmap:{name}", dict(cm.data or {}))


# ── 배포 수준: Podman ──────────────────────────────────────────────────────

def podman_cmd(ctx: Ctx) -> str:
    cmd = str(ctx.params.get("podman_cmd") or "podman").strip()
    if not cmd or any(ch in cmd for ch in ";|&`$\n\r") or len(cmd) > 64:
        raise CollectError("podman 명령 값이 올바르지 않습니다(한 줄, ; | & ` $ 금지).")
    return cmd


def collect_podman(ctx: Ctx) -> dict[str, Any]:
    name = (ctx.inst.container_name or "").strip()
    if not name:
        raise CollectError("컨테이너 이름이 비어 있습니다.")
    raw = ctx.ssh(f"{podman_cmd(ctx)} inspect {shlex.quote(name)}")
    try:
        info = json.loads(raw)[0]
    except (ValueError, IndexError, TypeError) as exc:
        raise CollectError(f"podman inspect 결과를 해석하지 못했습니다: {str(exc)[:200]}") from exc
    cfg = info.get("Config") or {}
    host = info.get("HostConfig") or {}
    env = dict(e.split("=", 1) if "=" in e else (e, "") for e in (cfg.get("Env") or []))
    data = {
        "image": cfg.get("Image") or info.get("ImageName"),
        "imageId": (info.get("Image") or "")[:19],
        "state": (info.get("State") or {}).get("Status"),
        "cmd": cfg.get("Cmd"), "entrypoint": cfg.get("Entrypoint"),
        "env": F.mask_env(env),
        "mounts": {m.get("Destination"): f"{m.get('Source')} ({'rw' if m.get('RW') else 'ro'})" for m in info.get("Mounts") or []},
        "ports": host.get("PortBindings"),
        "restartPolicy": (host.get("RestartPolicy") or {}).get("Name"),
        "memory": host.get("Memory"), "cpus": host.get("NanoCpus"),
        "network": host.get("NetworkMode"),
    }
    ctx.add("podman:inspect", data, {"image": data["image"]})
    return info


# ── 앱 설정 ──────────────────────────────────────────────────────────────────

_REALM_SKIP = {"id", "keys", "users", "clients", "roles", "groups", "identityProviders", "identityProviderMappers",
               "components", "authenticationFlows", "authenticatorConfig", "requiredActions", "clientScopes",
               "defaultRole", "scopeMappings", "clientScopeMappings", "protocolMappers", "federatedUsers"}


def collect_keycloak(ctx: Ctx) -> None:
    cred = ctx.creds.get("app_api") or {}
    if not cred.get("secret"):
        raise CollectError("관리자 API 자격증명이 없습니다 — 배포 설정만 수집했습니다.")
    auth_realm = ctx.params.get("auth_realm") or "master"
    client_id = ctx.params.get("client_id") or "admin-cli"
    form = ({"grant_type": "password", "client_id": client_id, "username": cred["username"], "password": cred["secret"]}
            if cred.get("username") else
            {"grant_type": "client_credentials", "client_id": client_id, "client_secret": cred["secret"]})
    with ctx.http() as http:
        url = f"{ctx.base_url()}/realms/{auth_realm}/protocol/openid-connect/token"
        ctx.log("info", f"POST {url} (grant_type={form['grant_type']}, client_id={client_id})")
        r = http.post(url, data=form)
        if r.status_code >= 400:
            raise CollectError(f"토큰 발급 실패 HTTP {r.status_code} — 계정·client 설정을 확인하세요.")
        hdr = {"Authorization": f"Bearer {r.json().get('access_token')}"}
        realms = [x.get("realm") for x in _get_json(ctx, http, "/admin/realms", headers=hdr) or []]
        wanted = ctx.params.get("realms") or []
        targets = [x for x in realms if not wanted or x in wanted]
        missing = [x for x in wanted if x not in realms]
        if missing:
            ctx.log("warn", f"realm 없음(또는 권한 없음): {', '.join(missing)}")
        for realm in targets:
            rep = _get_json(ctx, http, f"/admin/realms/{realm}", headers=hdr) or {}
            ctx.add(f"app:realm:{realm}", {k: v for k, v in rep.items() if k not in _REALM_SKIP})
            clients = _get_json(ctx, http, f"/admin/realms/{realm}/clients", headers=hdr) or []
            ctx.add(f"app:realm:{realm}:clients", [
                {"clientId": c.get("clientId"), "enabled": c.get("enabled"), "publicClient": c.get("publicClient"),
                 "protocol": c.get("protocol"), "redirectUris": c.get("redirectUris"), "webOrigins": c.get("webOrigins"),
                 "standardFlowEnabled": c.get("standardFlowEnabled"), "directAccessGrantsEnabled": c.get("directAccessGrantsEnabled"),
                 "serviceAccountsEnabled": c.get("serviceAccountsEnabled")} for c in clients])
            idps = _get_json(ctx, http, f"/admin/realms/{realm}/identity-provider/instances", headers=hdr) or []
            ctx.add(f"app:realm:{realm}:idp", [
                {"alias": i.get("alias"), "providerId": i.get("providerId"), "enabled": i.get("enabled"),
                 "config": i.get("config")} for i in idps])


def collect_jenkins(ctx: Ctx) -> None:
    auth = _basic(ctx)
    with ctx.http() as http:
        url = ctx.base_url() + "/api/json?tree=mode,numExecutors,useSecurity,quietingDown,nodeDescription,primaryView[name]"
        ctx.log("info", f"GET {url}")
        r = http.get(url, auth=auth)
        if r.status_code in (401, 403):
            raise CollectError(f"인증 실패({r.status_code}) — 사용자·API 토큰을 확인하세요.")
        if r.status_code >= 400:
            raise CollectError(f"HTTP {r.status_code}")
        data = r.json()
        data.pop("_class", None)
        data["version"] = r.headers.get("X-Jenkins")
        ctx.add("app:system", data, {"version": data["version"]})
        if ctx.params.get("plugins", True):
            plugins = _get_json(ctx, http, "/pluginManager/api/json?tree=plugins[shortName,version,active,enabled]", auth=auth)
            ctx.add("app:plugins", {p.get("shortName"): (p.get("version") or "") + ("" if p.get("enabled", True) else " (disabled)")
                                    for p in (plugins or {}).get("plugins", []) if p.get("shortName")})
    cm = (ctx.params.get("casc_configmap") or "").strip()
    if cm and ctx.inst.host_kind == "k8s":
        core, _apps = ctx.k8s()
        read_configmap(ctx, core, cm)


def collect_argocd(ctx: Ctx) -> None:
    if ctx.inst.host_kind == "k8s":
        core, _apps = ctx.k8s()
        for name in ctx.params.get("configmaps") or []:
            try:
                read_configmap(ctx, core, name)
            except Exception as exc:  # noqa: BLE001 — 없는 ConfigMap 은 경고만
                ctx.log("warn", f"ConfigMap {name} 읽기 실패: {str(exc)[:200]}")
    cred = ctx.creds.get("app_api") or {}
    if not cred.get("secret"):
        ctx.log("info", "API 토큰이 없어 클러스터·저장소 목록은 건너뜁니다.")
        return
    hdr = {"Authorization": f"Bearer {cred['secret']}"}
    with ctx.http() as http:
        clusters = _get_json(ctx, http, "/api/v1/clusters", headers=hdr) or {}
        ctx.add("app:clusters", {c.get("name") or c.get("server"): {
            "server": c.get("server"), "namespaces": c.get("namespaces"), "project": c.get("project"),
            "version": (c.get("info") or {}).get("serverVersion")} for c in clusters.get("items") or []})
        repos = _get_json(ctx, http, "/api/v1/repositories", headers=hdr) or {}
        ctx.add("app:repositories", {r.get("repo"): {"type": r.get("type"), "project": r.get("project"),
                                                       "insecure": r.get("insecure")} for r in repos.get("items") or []})


def collect_nexus(ctx: Ctx, podman_info: Optional[dict[str, Any]] = None) -> None:
    auth = _basic(ctx)
    with ctx.http() as http:
        url = ctx.base_url() + "/service/rest/v1/status/writable"
        ctx.log("info", f"GET {url}")
        w = http.get(url, auth=auth)
        ctx.log("info" if w.status_code == 200 else "warn", f"쓰기 가능 상태: HTTP {w.status_code}")
        repos = _get_json(ctx, http, "/service/rest/v1/repositories", auth=auth) or []
        ctx.add("app:repositories", {r.get("name"): {"format": r.get("format"), "type": r.get("type"),
                                                       "url": r.get("url")} for r in repos})
        if auth is None:
            ctx.log("info", "API 계정이 없어 blob store·보안 설정은 건너뜁니다(익명 조회 가능한 것만).")
        else:
            blobs = _get_json(ctx, http, "/service/rest/v1/blobstores", auth=auth) or []
            ctx.add("app:blobstores", {b.get("name"): {"type": b.get("type"), "softQuota": b.get("softQuota")} for b in blobs})
            realms = _get_json(ctx, http, "/service/rest/v1/security/realms/active", auth=auth)
            anon = _get_json(ctx, http, "/service/rest/v1/security/anonymous", auth=auth) or {}
            ctx.add("app:security", {"activeRealms": realms, "anonymous": anon})
    if ctx.inst.host_kind == "podman":
        data_dir = (ctx.params.get("data_dir") or "").strip()
        if data_dir:
            cmd = f"cat {shlex.quote(data_dir.rstrip('/') + '/etc/nexus.properties')}"
        else:
            cmd = f"{podman_cmd(ctx)} exec {shlex.quote(ctx.inst.container_name or '')} cat /nexus-data/etc/nexus.properties"
        try:
            ctx.add("file:nexus.properties", F.parse_properties(ctx.ssh(cmd)))
        except CollectError as exc:
            ctx.log("warn", f"nexus.properties 읽기 실패: {exc}")


_ROOTDSE_ATTRS = ["defaultNamingContext", "dnsHostName", "domainFunctionality", "forestFunctionality",
                  "domainControllerFunctionality", "supportedLDAPVersion", "namingContexts", "serverName"]


def collect_ldap(ctx: Ctx) -> None:
    try:
        import ldap3
    except ImportError as exc:  # optional 의존 — 없으면 offline
        raise CollectError("ldap3 패키지가 설치되어 있지 않습니다.") from exc
    url = ctx.base_url()
    cred = ctx.creds.get("ldap_bind") or {}
    timeout = int(ctx.params.get("timeout_sec") or 10)
    tls = None
    if url.lower().startswith("ldaps://") and not ctx.inst.tls_verify:
        import ssl

        tls = ldap3.Tls(validate=ssl.CERT_NONE)
    server = ldap3.Server(url, connect_timeout=timeout, tls=tls, get_info=ldap3.NONE)
    ctx.log("info", f"LDAP 바인드 {url} ({cred.get('username') or '익명'})")
    conn = ldap3.Connection(server, user=cred.get("username") or None, password=cred.get("secret") or None,
                            receive_timeout=timeout, read_only=True)
    if not conn.bind():
        raise CollectError(f"LDAP 바인드 실패: {conn.result.get('description')} {conn.result.get('message') or ''}".strip())
    try:
        conn.search("", "(objectClass=*)", search_scope=ldap3.BASE, attributes=_ROOTDSE_ATTRS)
        root = conn.entries[0].entry_attributes_as_dict if conn.entries else {}
        root = {k: (v[0] if isinstance(v, list) and len(v) == 1 else v) for k, v in root.items()}
        ctx.add("ldap:rootdse", root)
        base = (ctx.params.get("base_dn") or "").strip() or str(root.get("defaultNamingContext") or "")
        attrs = ctx.params.get("attributes") or []
        if base and attrs:
            ctx.log("info", f"도메인 객체 {base} 속성 {len(attrs)}개 조회")
            conn.search(base, "(objectClass=*)", search_scope=ldap3.BASE, attributes=attrs)
            dom = conn.entries[0].entry_attributes_as_dict if conn.entries else {}
            ctx.add("ldap:domain", {k: (v[0] if isinstance(v, list) and len(v) == 1 else (v or None)) for k, v in dom.items()})
        else:
            ctx.log("warn", "도메인 DN 을 알 수 없어 정책 속성은 건너뜁니다.")
    finally:
        conn.unbind()


APP_COLLECTORS: dict[str, Callable[..., None]] = {
    "keycloak": collect_keycloak, "jenkins": collect_jenkins, "argocd": collect_argocd,
    "nexus": collect_nexus, "ldap_ad": collect_ldap,
}
APP_LABELS = {"keycloak": "Keycloak realm 설정", "jenkins": "Jenkins 시스템·플러그인", "argocd": "ArgoCD 설정",
              "nexus": "Nexus 저장소·보안 설정", "ldap_ad": "AD rootDSE·도메인 정책"}
