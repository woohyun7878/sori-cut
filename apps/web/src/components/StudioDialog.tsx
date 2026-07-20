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
        className="relative max-h-[calc(100vh-32px)] w-full max-w-4xl overflow-y-auto rounded-editor border border-editor-border bg-canvas shadow-2xl"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className="sticky top-0 z-10 flex h-12 items-center justify-between border-b border-editor-border bg-canvas/95 px-4 backdrop-blur-sm">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-xl" aria-hidden="true">
              {icon}
            </span>
            <h2 id={titleId} className="truncate text-base font-semibold text-primary">
              {title}
            </h2>
          </div>
          <button onClick={onClose} type="button" className="studio-icon-button" aria-label="Close">
            <svg
              className="h-5 w-5"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
              aria-hidden="true"
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="p-4">{children}</div>
      </div>
    </div>
  );
}
