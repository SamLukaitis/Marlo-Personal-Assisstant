import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchTools, setToolEnabled as apiSetToolEnabled, type Tool } from "../api/client";
import { useAuth } from "./AuthContext";

interface ToolsContextValue {
  tools: Tool[];
  /** False until the first fetch resolves — callers must not render tool-gated UI before this. */
  loaded: boolean;
  isEnabled: (key: Tool["key"]) => boolean;
  setEnabled: (key: Tool["key"], enabled: boolean) => Promise<void>;
  refresh: () => Promise<void>;
}

const ToolsContext = createContext<ToolsContextValue | null>(null);

// Which tools a user has on decides what's in their sidebar, so it can't be per-page state any
// more — the Sidebar, Settings, and the tool-gated pages all have to agree, and toggling a tool
// in Settings has to move the nav immediately rather than on next reload.
export function ToolsProvider({ children }: { children: ReactNode }) {
  const { user } = useAuth();
  const [tools, setTools] = useState<Tool[]>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setTools(await fetchTools());
    } catch {
      // A failed load leaves `tools` empty, which reads as "nothing enabled" — the safe
      // direction: a missing nav item is recoverable, a nav item that 404s is not.
    } finally {
      setLoaded(true);
    }
  }, []);

  // /api/tools is authenticated, so this provider can sit above the whole router without firing
  // a guaranteed-401 on the public homepage. Re-fetches on login so a fresh session gets its own
  // tools rather than the previous user's.
  useEffect(() => {
    if (!user) {
      setTools([]);
      setLoaded(false);
      return;
    }
    refresh();
  }, [user, refresh]);

  const setEnabled = useCallback(async (key: Tool["key"], enabled: boolean) => {
    setTools((prev) => prev.map((t) => (t.key === key ? { ...t, enabled } : t)));
    try {
      await apiSetToolEnabled(key, enabled);
    } catch (err) {
      // Revert, or the sidebar shows a section the server doesn't think is on.
      setTools((prev) => prev.map((t) => (t.key === key ? { ...t, enabled: !enabled } : t)));
      throw err;
    }
  }, []);

  const isEnabled = useCallback(
    (key: Tool["key"]) => tools.some((t) => t.key === key && t.enabled),
    [tools]
  );

  return (
    <ToolsContext.Provider value={{ tools, loaded, isEnabled, setEnabled, refresh }}>
      {children}
    </ToolsContext.Provider>
  );
}

export function useTools(): ToolsContextValue {
  const ctx = useContext(ToolsContext);
  if (!ctx) throw new Error("useTools must be used inside a ToolsProvider");
  return ctx;
}
