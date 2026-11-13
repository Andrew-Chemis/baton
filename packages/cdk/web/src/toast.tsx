import { useEffect, useState } from 'preact/hooks';

interface Toast {
  id: number;
  kind: 'error' | 'info';
  text: string;
}

let toasts: Toast[] = [];
let counter = 0;
const listeners = new Set<(list: Toast[]) => void>();
const publish = () => listeners.forEach((l) => l(toasts));

export function notify(text: string, kind: Toast['kind'] = 'error'): void {
  const toast = { id: ++counter, kind, text };
  toasts = [...toasts, toast];
  publish();
  setTimeout(() => dismiss(toast.id), kind === 'error' ? 9000 : 4000);
}

function dismiss(id: number): void {
  toasts = toasts.filter((t) => t.id !== id);
  publish();
}

export function Toasts() {
  const [list, setList] = useState(toasts);
  useEffect(() => {
    listeners.add(setList);
    return () => void listeners.delete(setList);
  }, []);
  return (
    <div class="toasts" role="status" aria-live="polite">
      {list.map((t) => (
        <div key={t.id} class={`toast ${t.kind}`}>
          <span>{t.text}</span>
          <button type="button" class="plain" aria-label="Dismiss" onClick={() => dismiss(t.id)}>
            ×
          </button>
        </div>
      ))}
    </div>
  );
}
