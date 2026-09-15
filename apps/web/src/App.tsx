import { Routes, Route } from 'react-router-dom';
import { Workspace } from './pages/Workspace';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Workspace />} />
      {/* Bender is single-screen for now; a second route (e.g. /about) can slot
          in here later without disturbing the shell. */}
    </Routes>
  );
}
