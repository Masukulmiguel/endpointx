import React, { createContext, useContext, useState, useEffect, useCallback, type ReactNode } from 'react';
import api from '../services/api';

interface User {
  id: string;
  email: string;
  first_name: string;
  last_name: string;
  role_name: string;
  permissions: string[];
  is_active: boolean;
  last_login: string | null;
  created_at: string;
}

interface AuthContextType {
  user: User | null;
  isAuthenticated: boolean;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  hasPermission: (permission: string) => boolean;
  hasRole: (role: string) => boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

interface AuthProviderProps {
  children: ReactNode;
}

export function AuthProvider({ children }: AuthProviderProps) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchProfile = useCallback(async () => {
    try {
      const response = await api.getProfile() as { data: { user: User } };
      setUser(response.data.user);
    } catch {
      api.logout();
      setUser(null);
    }
  }, []);

  useEffect(() => {
    const initAuth = async () => {
      if (api.isAuthenticated()) {
        await fetchProfile();
      }
      setLoading(false);
    };
    initAuth();
  }, [fetchProfile]);

  useEffect(() => {
    const onForcedLogout = () => {
      setUser(null);
      setLoading(false);
    };
    window.addEventListener('auth:logout', onForcedLogout);
    return () => window.removeEventListener('auth:logout', onForcedLogout);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const response = await api.login(email, password) as {
      data: { accessToken: string; refreshToken: string; user: any };
    };
    api.setTokens(response.data.accessToken, response.data.refreshToken);
    setUser(response.data.user);
  }, []);

  const logout = useCallback(() => {
    api.logout();
    setUser(null);
  }, []);

  const hasPermission = useCallback(
    (permission: string) => {
      return user?.permissions?.includes(permission) ?? false;
    },
    [user]
  );

  const hasRole = useCallback(
    (role: string) => {
      return user?.role_name === role;
    },
    [user]
  );

  const value: AuthContextType = {
    user,
    isAuthenticated: !!user,
    loading,
    login,
    logout,
    hasPermission,
    hasRole,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextType {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

export default AuthContext;
