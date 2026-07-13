import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DropZone } from '../DropZone';

// Mock the store
vi.mock('../../store/useProjectStore', () => {
  const mockStore = vi.fn((selector: (state: Record<string, unknown>) => unknown) => {
    const state = {
      setOriginalAudio: vi.fn(),
      originalAudio: null,
    };
    return selector(state);
  });
  return { useProjectStore: mockStore };
});

describe('DropZone', () => {
  it('renders drop zone text', () => {
    render(<DropZone />);

    expect(screen.getByText('오디오 파일을 여기에 놓으세요')).toBeInTheDocument();
    expect(screen.getByText('Drop your audio file here')).toBeInTheDocument();
    expect(screen.getByText('MP3 · WAV · OGG · FLAC · M4A')).toBeInTheDocument();
  });

  it('renders the browse files button', () => {
    render(<DropZone />);

    expect(screen.getByRole('button', { name: /파일 선택/ })).toBeInTheDocument();
  });

  it('click triggers file input', async () => {
    const user = userEvent.setup();
    render(<DropZone />);

    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput).not.toBeNull();
    expect(fileInput.className).toContain('hidden');

    const clickSpy = vi.spyOn(fileInput, 'click');
    const button = screen.getByRole('button', { name: /파일 선택/ });
    await user.click(button);

    expect(clickSpy).toHaveBeenCalled();
  });
});
