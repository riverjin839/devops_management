const STORAGE_KEY_PREFIX = 'k8s:img:work-item:';

export function saveWorkItemImages(id: string, images: string[]) {
  if (images.length === 0) {
    localStorage.removeItem(STORAGE_KEY_PREFIX + id);
  } else {
    localStorage.setItem(STORAGE_KEY_PREFIX + id, JSON.stringify(images));
  }
}

export function loadWorkItemImages(id?: string): string[] {
  if (!id) return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY_PREFIX + id);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}
