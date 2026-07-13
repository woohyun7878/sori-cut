import { Routes, Route } from 'react-router-dom';
import { Landing } from './pages/Landing';
import { Studio } from './pages/Studio';
import { Export } from './pages/Export';

export function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/studio" element={<Studio />} />
      <Route path="/export" element={<Export />} />
    </Routes>
  );
}
