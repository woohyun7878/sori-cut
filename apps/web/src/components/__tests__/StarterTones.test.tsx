import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { StarterTones } from '../StarterTones';
import type { TemplateSummary } from '../../api/types';

const getTemplates = vi.fn<() => Promise<TemplateSummary[]>>();

vi.mock('../../api/client', () => ({
  getTemplates: () => getTemplates(),
}));

afterEach(() => {
  vi.clearAllMocks();
});

describe('StarterTones', () => {
  it('states the empty template list honestly', async () => {
    getTemplates.mockResolvedValue([]);

    render(<StarterTones />);

    expect(await screen.findByText('No starter tones yet')).toBeInTheDocument();
    expect(
      screen.getByText(/only when a real player has dialled and approved them/),
    ).toBeInTheDocument();
  });

  it('renders real templates when the backend has any', async () => {
    getTemplates.mockResolvedValue([
      { id: 'clean-1', name: 'Glassy Clean', category: 'Clean', summary: 'Sparkly Fender-ish clean.' },
    ]);

    render(<StarterTones />);

    expect(await screen.findByText('Glassy Clean')).toBeInTheDocument();
    expect(screen.getByText('Sparkly Fender-ish clean.')).toBeInTheDocument();
    expect(screen.queryByText('No starter tones yet')).not.toBeInTheDocument();
  });

  it('surfaces a load error instead of pretending there are none', async () => {
    getTemplates.mockRejectedValue(new Error('Bender backend is not running (start it with pnpm dev:server).'));

    render(<StarterTones />);

    expect(await screen.findByText(/pnpm dev:server/)).toBeInTheDocument();
  });
});
