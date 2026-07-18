import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';

const navLinks = [
  { to: '/', label: 'Home' },
  { to: '/studio', label: 'Studio' },
  { to: '/export', label: 'Export' },
] as const;

export function NavBar() {
  const [isOpen, setIsOpen] = useState(false);
  const location = useLocation();

  return (
    <nav
      className="sticky top-0 z-50 border-b border-gray-800 bg-gray-950/95 backdrop-blur-sm safe-top"
      aria-label="Primary"
    >
      <div className="flex items-center justify-between px-4 py-3 md:px-6 md:py-4">
        <Link to="/" className="text-xl font-bold" onClick={() => setIsOpen(false)} aria-label="소리컷 home">
          <span className="text-brand-400">소리</span>컷
        </Link>

        {/* Desktop nav */}
        <div className="hidden items-center gap-1 md:flex">
          {navLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              aria-current={location.pathname === link.to ? 'page' : undefined}
              className={[
                'rounded-lg px-4 py-2 text-sm font-medium transition-colors',
                location.pathname === link.to
                  ? 'bg-brand-600/20 text-brand-300'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white',
              ].join(' ')}
            >
              {link.label}
            </Link>
          ))}
        </div>

        {/* Mobile hamburger */}
        <button
          type="button"
          className="flex h-11 w-11 items-center justify-center rounded-xl text-gray-300 transition-colors hover:bg-gray-800 hover:text-white md:hidden"
          onClick={() => setIsOpen(!isOpen)}
          aria-label="Toggle navigation menu"
          aria-expanded={isOpen}
          aria-controls="mobile-nav-menu"
        >
          <svg className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2} aria-hidden="true">
            {isOpen ? (
              <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
            ) : (
              <path strokeLinecap="round" strokeLinejoin="round" d="M4 6h16M4 12h16M4 18h16" />
            )}
          </svg>
        </button>
      </div>

      {/* Mobile menu */}
      {isOpen && (
        <div id="mobile-nav-menu" className="border-t border-gray-800 px-4 pb-4 pt-2 md:hidden">
          {navLinks.map((link) => (
            <Link
              key={link.to}
              to={link.to}
              onClick={() => setIsOpen(false)}
              aria-current={location.pathname === link.to ? 'page' : undefined}
              className={[
                'block rounded-xl px-4 py-3 text-base font-medium transition-colors',
                location.pathname === link.to
                  ? 'bg-brand-600/20 text-brand-300'
                  : 'text-gray-300 hover:bg-gray-800 hover:text-white',
              ].join(' ')}
            >
              {link.label}
            </Link>
          ))}
        </div>
      )}
    </nav>
  );
}
