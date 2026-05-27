import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useState,
  useCallback,
} from "react";
import axios from "axios";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

// Все запросы к нашему API шлют cookies (для JWT в httpOnly)
axios.defaults.withCredentials = true;

const AuthContext = createContext(null);

export function formatApiError(detail) {
  if (detail == null) return "Что-то пошло не так. Попробуйте ещё раз.";
  if (typeof detail === "string") return detail;
  if (Array.isArray(detail))
    return detail
      .map((e) => (e && typeof e.msg === "string" ? e.msg : JSON.stringify(e)))
      .filter(Boolean)
      .join("; ");
  if (detail && typeof detail.msg === "string") return detail.msg;
  return String(detail);
}

export function AuthProvider({ children }) {
  // null = ещё проверяем; объект = вошёл; false = гость
  const [user, setUser] = useState(null);

  // Проверка сессии при загрузке
  useEffect(() => {
    let cancelled = false;
    axios
      .get(`${API}/auth/me`)
      .then((r) => {
        if (!cancelled) setUser(r.data);
      })
      .catch(() => {
        if (!cancelled) setUser(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const login = useCallback(async (email, password) => {
    const { data } = await axios.post(`${API}/auth/login`, { email, password });
    setUser(data);
    return data;
  }, []);

  const register = useCallback(async (email, password, displayName) => {
    const { data } = await axios.post(`${API}/auth/register`, {
      email,
      password,
      display_name: displayName,
    });
    setUser(data);
    return data;
  }, []);

  const logout = useCallback(async () => {
    try {
      await axios.post(`${API}/auth/logout`);
    } finally {
      setUser(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      user,
      isAuthenticated: !!user && user !== false,
      isChecking: user === null,
      login,
      register,
      logout,
    }),
    [user, login, register, logout]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be inside AuthProvider");
  return ctx;
}
