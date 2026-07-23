import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProjectManager } from './ProjectManager';
import { listProjects } from '../lib/projectStorage';

type ProjectManagerState = {
  projectId: string;
  projectName: string;
  setProjectName: ReturnType<typeof vi.fn>;
  loadFromSaved: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
};

let storeState: ProjectManagerState;

vi.mock('../store/useProjectStore', () => ({
  useProjectStore: (selector: (state: ProjectManagerState) => unknown) => selector(storeState),
}));

vi.mock('../lib/projectStorage', () => ({
  listProjects: vi.fn(),
  deleteProject: vi.fn(),
  loadProject: vi.fn(),
}));

beforeEach(() => {
  storeState = {
    projectId: 'current',
    projectName: 'My Project',
    setProjectName: vi.fn(),
    loadFromSaved: vi.fn(),
    reset: vi.fn(),
  };
  vi.mocked(listProjects).mockResolvedValue([]);
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe('ProjectManager accessibility', () => {
  it('labels the project name input', () => {
    render(<ProjectManager saveStatus="idle" />);
    expect(screen.getByRole('textbox', { name: 'Project name' })).toBeInTheDocument();
  });

  it('announces the save status through a live region', () => {
    render(<ProjectManager saveStatus="saved" />);
    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-live', 'polite');
    expect(status).toHaveTextContent('Saved');
  });

  it('marks the projects disclosure with aria-expanded state', async () => {
    render(<ProjectManager saveStatus="idle" />);
    const toggle = screen.getByRole('button', { name: 'Projects' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    // Disclosure pattern, not an APG menu: must not advertise a menu popup.
    expect(toggle).not.toHaveAttribute('aria-haspopup');

    fireEvent.click(toggle);
    await waitFor(() => expect(toggle).toHaveAttribute('aria-expanded', 'true'));
  });

  it('renders saved projects as keyboard-operable buttons', async () => {
    vi.mocked(listProjects).mockResolvedValue([
      { id: 'p1', name: 'Demo Reel', createdAt: 1, updatedAt: 2 },
    ]);
    render(<ProjectManager saveStatus="idle" />);

    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));

    expect(await screen.findByRole('button', { name: /^Demo Reel/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Delete project Demo Reel' }),
    ).toBeInTheDocument();
  });
});
