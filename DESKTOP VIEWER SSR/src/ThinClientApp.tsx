import { Route, Routes } from 'react-router-dom'
import { LoginPage, RequireAuth } from './features/auth/AuthPages'
import { ThinClientViewer } from './features/viewer/thin-client/ThinClientViewer'

export default function ThinClientApp() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/thin-client" element={<RequireAuth><ThinClientViewer /></RequireAuth>} />
      <Route path="*" element={<RequireAuth><ThinClientViewer /></RequireAuth>} />
    </Routes>
  )
}
