import { useId, useRef, type ReactNode } from 'react';
import { useFocusTrap } from '../hooks/useFocusTrap';

interface StudioDialogProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  icon: string;
  children: ReactNode;
}

export function StudioDialog({ isOpen, onClose, title, icon, children }: StudioDialogProps) {
  const overlayRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const titleId = useId();

  useFocusTrap(isOpen, panelRef, onClose);

  if (!isOpen) return null;

  return (
    <div
      ref={overlayRef}
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/60 backdrop-blur-sm p-4"
      onClick={(e) => {
        if (e.target === overlayRef.current) onClose();
      }}
    >
      <div
        ref={panelRef}
        className="relative w-full max-w-4xl max-h-[85vh] overflow-y-auto rounded-3xl border border-gray-700 bg-gray-950 shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between border-b border-gray-800 bg-gray-950/95 backdrop-blur-sm px-6 py-4 rounded-t-3xl">
          <div className="flex items-center gap-3">
            <span className="text-2xl" aria-hidden="true">{icon}</span>
            <h2 id={titleId} className="text-xl font-bold text-white">{title}</h2>
          </div>
          <button
            onClick={onClose}
            type="button"
            className="flex h-9 w-9 items-center justify-center rounded-xl text-gray-400 transition-colors hover:bg-gray-800 hover:text-white"
            aria-label="Close"
          >
            <svg className="h-5 w-5" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="p-6">
          {children}
        </div>
      </div>
    </div>
  );
}
