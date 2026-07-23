import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VideoUpload } from './VideoUpload';

type VideoState = {
  video: unknown;
  setVideo: ReturnType<typeof vi.fn>;
};

let storeState: VideoState;

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: VideoState) => unknown) => selector(storeState),
}));

beforeEach(() => {
  storeState = { video: null, setVideo: vi.fn() };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('VideoUpload accessibility', () => {
  it('exposes a keyboard-operable browse button that opens the file picker', () => {
    const { container } = render(<VideoUpload />);

    const browse = screen.getByRole('button', { name: /browse video/i });
    expect(browse).toBeInTheDocument();

    const input = container.querySelector('input[type="file"]') as HTMLInputElement;
    const clickSpy = vi.spyOn(input, 'click');
    fireEvent.click(browse);
    expect(clickSpy).toHaveBeenCalled();
  });

  it('announces an unsupported file selection through an alert region', async () => {
    const { container } = render(<VideoUpload />);
    const input = container.querySelector('input[type="file"]') as HTMLInputElement;

    const file = new File(['x'], 'notes.txt', { type: 'text/plain' });
    const files = {
      0: file,
      length: 1,
      item: (index: number) => (index === 0 ? file : null),
    } as unknown as FileList;
    fireEvent.change(input, { target: { files } });

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/supported formats/i);
    expect(storeState.setVideo).not.toHaveBeenCalled();
  });
});
