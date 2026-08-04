import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Sidebar } from "./components/Sidebar";
import { AssistantPage } from "./pages/AssistantPage";
import { SearchPage } from "./pages/SearchPage";
import { ChatsPage } from "./pages/ChatsPage";
import { CalendarPage } from "./pages/CalendarPage";
import { FilesPage } from "./pages/FilesPage";
import { SetupPage } from "./pages/SetupPage";

function App() {
  return (
    <BrowserRouter>
      <Sidebar />
      <Routes>
        <Route path="/" element={<AssistantPage />} />
        <Route path="/search" element={<SearchPage />} />
        <Route path="/inbox" element={<Navigate to="/search" replace />} />
        <Route path="/chats" element={<ChatsPage />} />
        <Route path="/calendar" element={<CalendarPage />} />
        <Route path="/files" element={<FilesPage />} />
        <Route path="/setup" element={<SetupPage />} />
      </Routes>
    </BrowserRouter>
  );
}

export default App;
