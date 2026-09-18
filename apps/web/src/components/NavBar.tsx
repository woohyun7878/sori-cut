import { Link } from 'react-router-dom';
import { ModelStatus } from './ModelStatus';

interface NavBarProps {
  /** Opens the keyboard-shortcuts overlay, when the host provides one. */
  onOpenHelp?: () => void;
}

/**
 * Bender's top bar: the brand on the left, the backend's state on the right.
 *
 * Bender is a single-screen app, so this is a brand + status bar rather than a
 * multi-page nav. Undo and redo live with the changes they act on, in the
 * review group, rather than being repeated up here.
 */
export function NavBar({ onOpenHelp }: NavBarProps) {
  return (
    <header
      className="sticky top-0 z-50 h-[62px] border-b border-editor-border bg-canvas/95 backdrop-blur-sm safe-top"
      role="banner"
    >
      <div className="mx-auto flex h-full w-[min(1240px,calc(100%-48px))] items-center justify-between gap-4 max-sm:w-[min(100%-32px,620px)]">
        <Link to="/" className="flex items-center gap-3" aria-label="Bender home">
          <span
            aria-hidden="true"
            className="h-[17px] w-[17px] rounded-[2px] border-2 border-brand-500 shadow-[inset_0_0_0_3px_rgb(var(--color-canvas)),0_0_14px_rgb(var(--color-brand)/0.34)]"
          />
          <span className="text-lg font-bold tracking-tight text-primary">Bender</span>
          <span aria-hidden="true" className="h-[18px] w-px bg-editor-border-strong max-sm:hidden" />
          <span className="eyebrow max-sm:hidden">Helix tone workspace</span>
        </Link>

        <div className="flex items-center gap-4 text-[13px] text-secondary">
          <ModelStatus />
          {onOpenHelp ? (
            <button
              type="button"
              onClick={onOpenHelp}
              className="grid h-[30px] w-[30px] flex-none place-items-center rounded-full border border-editor-border text-secondary transition-colors hover:border-muted hover:text-primary"
              aria-label="Keyboard shortcuts"
              title="Keyboard shortcuts (?)"
            >
              <svg
                className="h-[18px] w-[18px]"
                fill="none"
                viewBox="0 0 24 24"
                stroke="currentColor"
                strokeWidth={2}
                aria-hidden="true"
              >
                <path
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M8.228 9c.549-1.165 2.03-2 3.772-2 2.21 0 4 1.343 4 3 0 1.4-1.278 2.575-3.006 2.907-.542.104-.994.54-.994 1.093v1M12 17h.01"
                />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </button>
          ) : null}
        </div>
      </div>
    </header>
  );
}
