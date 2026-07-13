import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { Landing } from '../Landing';

describe('Landing', () => {
  it('renders brand name 소리컷', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    );

    expect(screen.getByText('소리')).toBeInTheDocument();
    expect(screen.getByText('컷')).toBeInTheDocument();
    expect(screen.getByText('sori-cut')).toBeInTheDocument();
  });

  it('renders feature cards', () => {
    render(
      <MemoryRouter>
        <Landing />
      </MemoryRouter>,
    );

    expect(screen.getByText('스템 분리')).toBeInTheDocument();
    expect(screen.getByText('Stem Splitting')).toBeInTheDocument();
    expect(screen.getByText('녹음 스튜디오')).toBeInTheDocument();
    expect(screen.getByText('Recording Studio')).toBeInTheDocument();
    expect(screen.getByText('영상 싱크')).toBeInTheDocument();
    expect(screen.getByText('Video Sync')).toBeInTheDocument();
    expect(screen.getByText('타임라인 편집')).toBeInTheDocument();
    expect(screen.getByText('Timeline Editor')).toBeInTheDocument();
  });
});
