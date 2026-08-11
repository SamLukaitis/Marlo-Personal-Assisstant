import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { fetchMe, UnauthorizedError, type Me } from "../api/client";

interface AuthState {
  user: Me | null;
  loading: boolean;
  // Re-fetches /api/me — call after something that could change auth state (e.g. returning
  // from the OAuth login-signin redirect) rather than requiring a full page reload.
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);

  async function refresh(): Promise<void> {
    try {
      setUser(await fetchMe());
    } catch (err) {
      if (!(err instanceof UnauthorizedError)) {
        console.error("failed to check auth state", err);
      }
      setUser(null);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return <AuthContext.Provider value={{ user, loading, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within an AuthProvider");
  return ctx;
}
