import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { AuthedLayout } from "./components/AuthedLayout";
import { RequireAuth } from "./components/RequireAuth";
import { HomePage } from "./pages/HomePage";
import { OnboardingPage } from "./pages/OnboardingPage";
import { AssistantPage } from "./pages/AssistantPage";
import { SearchPage } from "./pages/SearchPage";
import { ChatsPage } from "./pages/ChatsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { FilesPage } from "./pages/FilesPage";
import { SetupPage } from "./pages/SetupPage";

function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Public — the sidebar/nav must not render here, there's no hub to navigate yet */}
        <Route path="/" element={<HomePage />} />

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
          <Route path="/search" element={<SearchPage />} />
          <Route path="/inbox" element={<Navigate to="/search" replace />} />
          <Route path="/chats" element={<ChatsPage />} />
          <Route path="/calendar" element={<CalendarPage />} />
          <Route path="/files" element={<FilesPage />} />
          <Route path="/setup" element={<SetupPage />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}

export default App;
