import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthedLayout } from "./components/AuthedLayout";
import { RequireAuth } from "./components/RequireAuth";
import { ToolsProvider } from "./context/ToolsContext";
import { HomePage } from "./pages/HomePage";
import { ConnectedPage } from "./pages/ConnectedPage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { AssistantPage } from "./pages/AssistantPage";
import { ChatsPage } from "./pages/ChatsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { FilesPage } from "./pages/FilesPage";
import { TravelPage } from "./pages/TravelPage";
import { SettingsPage } from "./pages/SettingsPage";
import { PortalPage } from "./pages/PortalPage";

function App() {
  return (
    <ToolsProvider>
      <BrowserRouter>
        <Routes>
          {/* Public — the sidebar/nav must not render here, there's no hub to navigate yet */}
          <Route path="/" element={<HomePage />} />
          {/* Lands here after the WhatsApp-native registration flow's OAuth round trip — no
              session exists yet at this point, so this must stay outside RequireAuth. */}
          <Route path="/connected" element={<ConnectedPage />} />

          <Route
            path="/onboarding"
            element={
              <RequireAuth>
                <OnboardingPage />
              </RequireAuth>
            }
          />

          {/* Everything below requires a session and gets the normal sidebar layout */}
          <Route
            element={
              <RequireAuth>
                <AuthedLayout />
              </RequireAuth>
            }
          >
            <Route path="/assistant" element={<AssistantPage />} />
            {/* Search folded into Files (file/document search) + the Assistant chat (mail/Teams
                lookups via natural language). Old links keep working. */}
            <Route path="/search" element={<Navigate to="/files" replace />} />
            <Route path="/inbox" element={<Navigate to="/files" replace />} />
            <Route path="/chats" element={<ChatsPage />} />
            <Route path="/calendar" element={<CalendarPage />} />
            <Route path="/files" element={<FilesPage />} />
            <Route path="/travel" element={<TravelPage />} />
            <Route path="/settings" element={<SettingsPage />} />
            <Route path="/portal" element={<PortalPage />} />
            {/* "Setup" was renamed to "Settings" — it behaves like one now. */}
            <Route path="/setup" element={<Navigate to="/settings" replace />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </ToolsProvider>
  );
}

export default App;
