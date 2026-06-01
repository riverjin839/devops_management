import { useAuthStore } from '@/stores/authStore';
import { authApi } from '@/services/api';

export function useEditorWhiteBg() {
  const user = useAuthStore((s) => s.user);
  const setUser = useAuthStore((s) => s.setUser);
  const editorWhiteBg = user?.editorWhiteBg ?? false;

  const toggle = async () => {
    if (!user) return;
    const prev = user;
    const next = !editorWhiteBg;
    setUser({ ...user, editorWhiteBg: next });
    try {
      await authApi.patchPreferences({ editorWhiteBg: next });
    } catch {
      setUser(prev);
    }
  };

  return { editorWhiteBg, toggle, isLoggedIn: !!user };
}
