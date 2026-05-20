from app.routers.clusters import router as clusters_router
from app.routers.health import router as health_router
from app.routers.history import router as history_router
from app.routers.daily_check import router as daily_check_router
from app.routers.playbooks import router as playbooks_router
from app.routers.agent import router as agent_router
from app.routers.promql import router as promql_router
from app.routers.openclaw import router as openclaw_router
from app.routers.work_items import router as work_items_router
from app.routers.ui_settings import router as ui_settings_router
from app.routers.node_labels import router as node_labels_router
from app.routers.node_images import router as node_images_router
from app.routers.workflows import router as workflows_router
from app.routers.work_guide import router as work_guide_router
from app.routers.ops_note import router as ops_note_router
from app.routers.mindmap import router as mindmap_router
from app.routers.management_servers import router as management_server_router
from app.routers.infra_nodes import router as infra_nodes_router
from app.routers.topology_trace import router as topology_trace_router
from app.routers.ontology import router as ontology_router
from app.routers.analyze import router as analyze_router
from app.routers.trends import router as trends_router
from app.routers.versions import router as versions_router
from app.routers.bulk_exec import router as bulk_exec_router
from app.routers.etcdctl import router as etcdctl_router
from app.routers.cilium_trace import router as cilium_trace_router
from app.routers.mc_client import router as mc_client_router
from app.routers.node_server_specs import router as node_server_specs_router
from app.routers.cluster_custom_fields import router as cluster_custom_fields_router
from app.routers.backup import router as backup_router
from app.routers.service_entries import router as service_entries_router
from app.routers.batch_jobs import router as batch_jobs_router
from app.routers.commands import router as commands_router
from app.routers.ansible_assets import (
    files_router as ansible_files_router,
    inv_router as ansible_inventories_router,
)
from app.routers.auth import router as auth_router
from app.routers.audit_logs import router as audit_logs_router
from app.routers.deep_check import router as deep_check_router, ingest_router as deep_check_ingest_router
from app.routers.deep_check_definitions import router as deep_check_definitions_router
from app.routers.notifications import router as notifications_router

__all__ = [
    "clusters_router",
    "health_router",
    "history_router",
    "daily_check_router",
    "playbooks_router",
    "agent_router",
    "promql_router",
    "openclaw_router",
    "work_items_router",
    "ui_settings_router",
    "node_labels_router",
    "node_images_router",
    "workflows_router",
    "work_guide_router",
    "ops_note_router",
    "mindmap_router",
    "management_server_router",
    "infra_nodes_router",
    "topology_trace_router",
    "ontology_router",
    "analyze_router",
    "trends_router",
    "versions_router",
    "bulk_exec_router",
    "etcdctl_router",
    "cilium_trace_router",
    "mc_client_router",
    "node_server_specs_router",
    "cluster_custom_fields_router",
    "backup_router",
    "service_entries_router",
    "batch_jobs_router",
    "commands_router",
    "ansible_files_router",
    "ansible_inventories_router",
    "auth_router",
    "audit_logs_router",
    "deep_check_router",
    "deep_check_ingest_router",
    "deep_check_definitions_router",
    "notifications_router",
]
