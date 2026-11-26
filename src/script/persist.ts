import { useEffect, useState } from 'react';

/**
 * useState saved in localStorage, kept in sync across components and tabs that use the same key.
 */
export function usePersistentState<T>(key: string, initial: T) {
  const read = (): T => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as T) : initial;
    } catch {
      return initial;
    }
  };
  const [v, setV] = useState<T>(read);
  useEffect(() => {
    const onChange = (e: Event) => {
      if ((e as CustomEvent).detail === key || (e as StorageEvent).key === key) setV(read());
    };
    window.addEventListener('hs-store', onChange);
    window.addEventListener('storage', onChange);
    return () => {
      window.removeEventListener('hs-store', onChange);
      window.removeEventListener('storage', onChange);
    };
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  const set = (next: T | ((p: T) => T)) => {
    setV((prev) => {
      const value = typeof next === 'function' ? (next as (p: T) => T)(prev) : next;
      try {
        localStorage.setItem(key, JSON.stringify(value));
      } catch {
        /* not persisted */
      }
      queueMicrotask(() => window.dispatchEvent(new CustomEvent('hs-store', { detail: key })));
      return value;
    });
  };
  return [v, set] as const;
}
