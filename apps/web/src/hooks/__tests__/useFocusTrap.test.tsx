import { useRef, useState } from 'react';
import { afterEach, describe, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useFocusTrap } from '../useFocusTrap';

afterEach(cleanup);

function Dialog({ onClose }: { onClose?: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(true, ref, onClose);

  return (
    <div ref={ref} role="dialog" aria-label="Test dialog" tabIndex={-1}>
      <button type="button">First</button>
      <button type="button">Second</button>
      <button type="button">Third</button>
    </div>
  );
}

function Harness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open dialog
      </button>
      {open ? (
        <Dialog
          onClose={() => {
            setOpen(false);
            onClose?.();
          }}
        />
      ) : null}
    </>
  );
}

describe('useFocusTrap', () => {
  it('moves focus to the first focusable element when activated', () => {
    render(<Dialog />);

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<Dialog onClose={onClose} />);

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab focus within the container', () => {
    render(<Dialog />);

    const first = screen.getByRole('button', { name: 'First' });
    const third = screen.getByRole('button', { name: 'Third' });

    third.focus();
    fireEvent.keyDown(third, { key: 'Tab' });
    expect(document.activeElement).toBe(first);

    first.focus();
    fireEvent.keyDown(first, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(third);
  });

  it('restores focus to the trigger element when deactivated', () => {
    const onClose = vi.fn();
    render(<Harness onClose={onClose} />);

    const trigger = screen.getByRole('button', { name: 'Open dialog' });
    trigger.focus();
    fireEvent.click(trigger);

    // Focus moved into the dialog.
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'First' }));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });

    // Dialog unmounted and focus returned to the trigger.
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(document.activeElement).toBe(trigger);
  });
});
