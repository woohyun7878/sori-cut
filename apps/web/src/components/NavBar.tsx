import { Link } from 'react-router-dom';
import { UndoRedoButtons } from './UndoRedoButtons';

interface NavBarProps {
  /** Opens the keyboard-shortcuts overlay, when the host provides one. */
  onOpenHelp?: () => void;
}

/**
 * Bender's top bar: the brand on the left, global actions on the right.
 *
 * Bender is a single-screen app, so this is a brand + action bar rather than a
 * multi-page nav. The brand still links to `/` so a future second route (e.g.
 * `/about`) has an obvious way home.
 */
export function NavBar({ onOpenHelp }: NavBarProps) {
  return (
    <header
      className="sticky top-0 z-50 flex items-center justify-between gap-3 border-b border-editor-border bg-surface/95 px-4 py-3 backdrop-blur-sm safe-top"
      role="banner"
    >
      <Link to="/" className="flex items-center gap-2.5" aria-label="Bender home">
        <span className="led" aria-hidden="true" />
        <span className="text-lg font-bold tracking-tight text-primary">Bender</span>
        <span className="hidden text-xs text-muted sm:inline">AI guitar tone engineer</span>
      </Link>

      <div className="flex items-center gap-1">
        <UndoRedoButtons />
        {onOpenHelp ? (
          <button
            type="button"
            onClick={onOpenHelp}
            className="icon-button"
            aria-label="Keyboard shortcuts"
            title="Keyboard shortcuts (?)"
          >
            <svg
              className="h-5 w-5"
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
    </header>
  );
}
