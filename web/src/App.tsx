import { Route, Routes } from 'react-router-dom';
import Shell from './components/Shell.tsx';
import Overview from './pages/Overview.tsx';
import Sessions from './pages/Sessions.tsx';
import SessionDetail from './pages/SessionDetail.tsx';
import Lessons from './pages/Lessons.tsx';
import Skills from './pages/Skills.tsx';
import Usage from './pages/Usage.tsx';
import { api } from './api.ts';
import { useAsync } from './lib/useAsync.ts';

export default function App() {
  const overview = useAsync(() => api.overview(), []);

  return (
    <Routes>
      <Route
        element={
          <Shell
            deviceName={overview.data?.device.name ?? 'trove'}
            daemonRunning={overview.data?.daemon.running ?? false}
            lastRunAt={overview.data?.daemon.status?.lastRunAt}
          />
        }
      >
        <Route path="/" element={<Overview />} />
        <Route path="/sessions" element={<Sessions />} />
        <Route path="/sessions/:key" element={<SessionDetail />} />
        <Route path="/lessons" element={<Lessons />} />
        <Route path="/skills" element={<Skills />} />
        <Route path="/usage" element={<Usage />} />
      </Route>
    </Routes>
  );
}
