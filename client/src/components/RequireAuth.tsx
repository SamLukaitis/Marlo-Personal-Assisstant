import type { ReactNode } from "react";
import { Navigate } from "react-router-dom";
import { useAuth } from "../context/AuthContext";

export function RequireAuth({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) return null; // brief flash-avoidance — /api/me hasn't resolved yet
  if (!user) return <Navigate to="/" replace />;
  return <>{children}</>;
}
