import { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { Addon } from '@/types';
import { useCreateAddon, useUpdateAddon } from '@/hooks/useCluster';

interface AddAddonModalProps {
  isOpen: boolean;
  onClose: () => void;
  clusterId: string;
  editingAddon?: Addon | null;
}

const ADDON_TEMPLATES = [
  {
    label: 'K8s Core',
    items: [
      { name: 'etcd Leader', type: 'etcd-leader', icon: '💾', description: 'etcd leader election & health status', configFields: [] },
      { name: 'Node Status', type: 'node-check', icon: '🖥️', description: 'Node readiness & pressure conditions', configFields: [] },
      { name: 'Control Plane', type: 'control-plane', icon: '🎛️', description: 'API Server, Scheduler, Controller Manager', configFields: [] },
      { name: 'CoreDNS', type: 'system-pod', icon: '🔍', description: 'Cluster DNS service', configFields: [] },
    ],
  },
  {
    label: 'DevOps Tools',
    items: [
      {
        name: 'Nexus Repository', type: 'nexus', icon: '📦', description: 'Nexus writable & availability',
        configFields: [{ key: 'url', label: 'Nexus URL', placeholder: 'http://nexus.devops.svc:8081', required: true }],
      },
      {
        name: 'Jenkins', type: 'jenkins', icon: '🔧', description: 'Jenkins mode, executors & queue',
        configFields: [
          { key: 'url', label: 'Jenkins URL', placeholder: 'http://jenkins.devops.svc:8080', required: true },
          { key: 'username', label: 'Username', placeholder: '(optional)', required: false },
          { key: 'api_token', label: 'API Token', placeholder: '(optional)', required: false },
        ],
      },
      {
        name: 'ArgoCD', type: 'argocd', icon: '🔄', description: 'Application sync & health status',
        configFields: [{ key: 'namespace', label: 'Namespace', placeholder: 'argocd', required: false }],
      },
      {
        name: 'Keycloak', type: 'keycloak', icon: '🛡️', description: 'Auth service readiness & DB status',
        configFields: [{ key: 'url', label: 'Keycloak URL', placeholder: 'http://keycloak.auth.svc:8080', required: true }],
      },
    ],
  },
];

type ConfigField = { key: string; label: string; placeholder: string; required: boolean };
type Template = { name: string; type: string; icon: string; description: string; configFields: ConfigField[] };

export function AddAddonModal({ isOpen, onClose, clusterId, editingAddon }: AddAddonModalProps) {
  const [selected, setSelected] = useState<Template | null>(null);
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const createAddon = useCreateAddon();
  const updateAddon = useUpdateAddon();

  useEffect(() => {
    if (!isOpen) {
      setSelected(null);
      setConfigValues({});
      return;
    }

    if (editingAddon) {
      const template = ADDON_TEMPLATES.flatMap((group) => group.items).find((tpl) => tpl.type === editingAddon.type) ?? null;
      setSelected(template);
      const existingConfig: Record<string, string> = {};
      Object.entries(editingAddon.config ?? {}).forEach(([key, value]) => {
        existingConfig[key] = String(value);
      });
      setConfigValues(existingConfig);
    }
  }, [isOpen, editingAddon]);

  if (!isOpen) return null;

  const handleSelect = (tpl: Template) => {
    setSelected(tpl);
    // pre-fill defaults from placeholders
    const defaults: Record<string, string> = {};
    tpl.configFields.forEach((f) => {
      if (f.required && f.placeholder && !f.placeholder.startsWith('(')) {
        defaults[f.key] = f.placeholder;
      }
    });
    setConfigValues(defaults);
  };

  const currentTemplate = selected ?? ADDON_TEMPLATES.flatMap((group) => group.items).find((tpl) => tpl.type === editingAddon?.type) ?? null;

  const handleSubmit = () => {
    if (editingAddon) {
      const config: Record<string, string> = {};
      Object.entries(configValues).forEach(([key, value]) => {
        const trimmed = value.trim();
        if (trimmed) config[key] = trimmed;
      });

      updateAddon.mutate({
        id: editingAddon.id,
        data: {
          clusterId: editingAddon.clusterId,
          name: editingAddon.name,
          type: editingAddon.type,
          icon: editingAddon.icon,
          description: editingAddon.description,
          config: Object.keys(config).length > 0 ? config : undefined,
        },
      });

      setSelected(null);
      setConfigValues({});
      onClose();
      return;
    }

    if (!selected || !clusterId) return;

    const config: Record<string, string> = {};
    let valid = true;
    selected.configFields.forEach((f) => {
      const val = configValues[f.key]?.trim() || '';
      if (f.required && !val) {
        valid = false;
      }
      if (val) config[f.key] = val;
    });

    if (!valid) return;

    createAddon.mutate({
      clusterId,
      name: selected.name,
      type: selected.type,
      icon: selected.icon,
      description: selected.description,
      config: Object.keys(config).length > 0 ? config : undefined,
    });

    setSelected(null);
    setConfigValues({});
    onClose();
  };

  const handleBack = () => {
    setSelected(null);
    setConfigValues({});
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={onClose}>
      <div className="bg-card border border-border rounded-2xl shadow-xl w-full max-w-3xl mx-4" onClick={(e) => e.stopPropagation()}>
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-border">
          <h2 className="text-lg font-semibold">
            {editingAddon ? `Edit: ${editingAddon.name}` : selected ? selected.name : 'Add Health Check'}
          </h2>
          <button onClick={onClose} className="p-1 hover:bg-secondary rounded-lg transition-colors">
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="px-6 py-5">
          {!selected && !editingAddon ? (
            /* ── Step 1: Type selection ── */
            <div className="space-y-5">
              {ADDON_TEMPLATES.map((group) => (
                <div key={group.label}>
                  <h3 className="text-sm font-semibold text-muted-foreground uppercase tracking-wider mb-2">
                    {group.label}
                  </h3>
                  <div className="grid grid-cols-2 gap-2">
                    {group.items.map((tpl) => (
                      <button
                        key={tpl.type}
                        onClick={() => handleSelect(tpl)}
                        className="flex items-center gap-3 p-3 rounded-xl border border-border hover:border-primary/40 hover:bg-primary/5 transition-all text-left"
                      >
                        <span className="text-2xl">{tpl.icon}</span>
                        <div>
                          <div className="text-sm font-medium">{tpl.name}</div>
                          <div className="text-sm text-muted-foreground">{tpl.description}</div>
                        </div>
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            /* ── Step 2: Config fields ── */
            <div className="space-y-4">
              <div className="flex items-center gap-3 p-3 bg-secondary/50 rounded-xl">
                <span className="text-2xl">{(currentTemplate || editingAddon)?.icon}</span>
                <div>
                  <div className="text-sm font-medium">{(currentTemplate || editingAddon)?.name}</div>
                  <div className="text-sm text-muted-foreground">{(currentTemplate || editingAddon)?.description}</div>
                </div>
              </div>

              {currentTemplate && currentTemplate.configFields.length > 0 ? (
                currentTemplate.configFields.map((field) => (
                  <div key={field.key}>
                    <label className="block text-sm font-medium mb-1">
                      {field.label}
                      {field.required && <span className="text-red-400 ml-1">*</span>}
                    </label>
                    <input
                      type={field.key.includes('token') || field.key.includes('password') ? 'password' : 'text'}
                      value={configValues[field.key] ?? ''}
                      onChange={(e) => setConfigValues({ ...configValues, [field.key]: e.target.value })}
                      placeholder={field.placeholder}
                      className="w-full px-3 py-2 bg-secondary border border-border rounded-lg text-sm font-mono focus:outline-none focus:ring-2 focus:ring-primary/50"
                    />
                  </div>
                ))
              ) : (
                <p className="text-sm text-muted-foreground">
                  No additional configuration needed. Uses in-cluster K8s API.
                </p>
              )}

              <div className="flex gap-3 pt-2">
                <button
                  onClick={editingAddon ? onClose : handleBack}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-secondary hover:bg-secondary/80 border border-border rounded-lg transition-colors"
                >
                  {editingAddon ? 'Cancel' : 'Back'}
                </button>
                <button
                  onClick={handleSubmit}
                  className="flex-1 px-4 py-2 text-sm font-medium bg-primary hover:bg-primary/90 text-primary-foreground rounded-lg transition-colors"
                >
                  {editingAddon ? 'Save' : 'Add Check'}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
