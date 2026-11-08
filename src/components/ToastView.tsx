import { useEffect } from 'react';
import type { Toast } from '../state/useTriage';

export function ToastView({ toast, onClose }: { toast: Toast | null; onClose: () => void }) {
  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(onClose, 4000);
    return () => clearTimeout(id);
  }, [toast, onClose]);
  if (!toast) return null;
  return (
    <div className="toast" role="status">
      <span>{toast.text}</span>
      {toast.undo && (
        <button type="button" onClick={() => { toast.undo!(); onClose(); }}>
          元に戻す
        </button>
      )}
    </div>
  );
}
