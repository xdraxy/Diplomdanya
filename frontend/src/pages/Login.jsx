import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import {
  Music,
  ArrowRight,
  Loader2,
  Plus,
  LogIn,
  UserPlus,
  Users,
  LogOut,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";

import { useAuth, formatApiError } from "@/context/AuthContext";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;
const NAME_REGEX = /^[a-zA-Zа-яА-ЯёЁ0-9 .\-_]+$/;

export default function Login() {
  const navigate = useNavigate();
  const { user, isAuthenticated, isChecking, login, register, logout } =
    useAuth();

  // Гостевое имя (если пользователь не вошёл)
  const [guestName, setGuestName] = useState(
    () => localStorage.getItem("syncplay_name") || ""
  );
  const [code, setCode] = useState("");

  // Поля авторизации
  const [authEmail, setAuthEmail] = useState("");
  const [authPassword, setAuthPassword] = useState("");
  const [authDisplayName, setAuthDisplayName] = useState("");
  const [authBusy, setAuthBusy] = useState(false);

  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  // Когда пользователь авторизуется — синхронизируем guestName с его display_name
  useEffect(() => {
    if (user && user.display_name) {
      setGuestName(user.display_name);
      localStorage.setItem("syncplay_name", user.display_name);
    }
  }, [user]);

  const resolveName = () => {
    if (isAuthenticated && user?.display_name) return user.display_name;
    const trimmed = guestName.trim();
    if (trimmed.length < 2) {
      toast.error("Введите имя минимум из 2 символов");
      return null;
    }
    if (!NAME_REGEX.test(trimmed)) {
      toast.error("Имя: только русские/английские буквы и цифры");
      return null;
    }
    return trimmed;
  };

  const handleCreate = async () => {
    const name = resolveName();
    if (!name) return;
    setCreating(true);
    try {
      const { data } = await axios.post(`${API}/rooms`);
      localStorage.setItem("syncplay_name", name);
      toast.success(`Комната создана: ${data.code}`);
      navigate(`/room/${data.code}`);
    } catch {
      toast.error("Не удалось создать комнату");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const name = resolveName();
    if (!name) return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) {
      toast.error("Код комнаты должен состоять из 6 цифр");
      return;
    }
    setJoining(true);
    try {
      await axios.get(`${API}/rooms/${clean}`);
      localStorage.setItem("syncplay_name", name);
      navigate(`/room/${clean}`);
    } catch (e) {
      if (e?.response?.status === 404) toast.error("Комната не найдена");
      else toast.error("Не удалось войти в комнату");
    } finally {
      setJoining(false);
    }
  };

  const handleLogin = async () => {
    if (!authEmail || !authPassword) {
      toast.error("Заполните все поля");
      return;
    }
    setAuthBusy(true);
    try {
      await login(authEmail.trim(), authPassword);
      toast.success("Вы вошли");
      setAuthEmail("");
      setAuthPassword("");
    } catch (e) {
      toast.error(formatApiError(e?.response?.data?.detail) || "Ошибка входа");
    } finally {
      setAuthBusy(false);
    }
  };

  const handleRegister = async () => {
    if (!authEmail || !authPassword || !authDisplayName) {
      toast.error("Заполните все поля");
      return;
    }
    if (authPassword.length < 6) {
      toast.error("Пароль должен быть не менее 6 символов");
      return;
    }
    setAuthBusy(true);
    try {
      await register(authEmail.trim(), authPassword, authDisplayName.trim());
      toast.success("Регистрация прошла успешно");
      setAuthEmail("");
      setAuthPassword("");
      setAuthDisplayName("");
    } catch (e) {
      toast.error(
        formatApiError(e?.response?.data?.detail) || "Ошибка регистрации"
      );
    } finally {
      setAuthBusy(false);
    }
  };

  if (isChecking) {
    return (
      <div className="app-bg grid-bg min-h-screen flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-cyan-500" />
      </div>
    );
  }

  return (
    <div
      className="app-bg grid-bg min-h-screen flex items-center justify-center px-4 py-12"
      data-testid="login-page"
    >
      <div className="w-full max-w-md fade-up">
        <div className="flex items-center justify-center gap-3 mb-8">
          <div className="w-12 h-12 rounded-xl bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
            <Music className="w-6 h-6 text-cyan-400" />
          </div>
          <div>
            <h1 className="text-3xl font-black tracking-tight text-white mono">
              SyncPlay
            </h1>
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500">
              синхронное прослушивание
            </p>
          </div>
        </div>

        {/* Информация о текущем аккаунте */}
        {isAuthenticated && (
          <div
            className="mb-4 flex items-center justify-between gap-3 px-4 py-3 rounded-xl bg-zinc-900/70 border border-cyan-500/30"
            data-testid="auth-summary"
          >
            <div className="min-w-0">
              <div className="text-[10px] uppercase tracking-[0.2em] text-cyan-500">
                Вы вошли как
              </div>
              <div className="text-sm text-white truncate">
                {user.display_name}{" "}
                <span className="text-zinc-500 text-xs">({user.email})</span>
              </div>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={async () => {
                await logout();
                toast("Вы вышли");
              }}
              className="text-zinc-400 hover:text-red-400 hover:bg-red-500/10 shrink-0"
              data-testid="logout-button"
            >
              <LogOut className="w-4 h-4" />
            </Button>
          </div>
        )}

        <Card className="bg-zinc-900/70 backdrop-blur-md border border-zinc-800 rounded-2xl shadow-2xl p-6">
          {/* Если не вошёл — показываем поле «гостевое имя» + табы (вход/рег) */}
          {!isAuthenticated && (
            <>
              <div className="mb-4">
                <label className="block text-xs uppercase tracking-[0.1em] text-zinc-500 mb-2">
                  Ваше имя (гость)
                </label>
                <Input
                  data-testid="login-name-input"
                  value={guestName}
                  onChange={(e) => setGuestName(e.target.value)}
                  placeholder="Например, Алексей"
                  maxLength={50}
                  className="bg-zinc-950/60 border-zinc-700 text-white placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-cyan-500 focus-visible:border-cyan-500 rounded-lg h-11"
                />
              </div>

              <details
                className="mb-4 group"
                data-testid="auth-collapsible"
              >
                <summary className="cursor-pointer text-xs uppercase tracking-[0.1em] text-cyan-500 hover:text-cyan-400 select-none flex items-center gap-2">
                  <UserPlus className="w-3.5 h-3.5" />
                  Войти или зарегистрироваться (не обязательно)
                </summary>

                <div className="mt-4">
                  <Tabs defaultValue="signin" className="w-full">
                    <TabsList className="grid w-full grid-cols-2 bg-zinc-950/60 border border-zinc-800">
                      <TabsTrigger
                        value="signin"
                        data-testid="tab-signin"
                        className="data-[state=active]:bg-cyan-500 data-[state=active]:text-black"
                      >
                        Вход
                      </TabsTrigger>
                      <TabsTrigger
                        value="signup"
                        data-testid="tab-signup"
                        className="data-[state=active]:bg-cyan-500 data-[state=active]:text-black"
                      >
                        Регистрация
                      </TabsTrigger>
                    </TabsList>

                    <TabsContent value="signin" className="mt-3 space-y-2">
                      <Input
                        data-testid="signin-email"
                        type="email"
                        placeholder="E-mail"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        className="bg-zinc-950/60 border-zinc-700 text-white h-10 rounded-lg"
                      />
                      <Input
                        data-testid="signin-password"
                        type="password"
                        placeholder="Пароль"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleLogin()}
                        className="bg-zinc-950/60 border-zinc-700 text-white h-10 rounded-lg"
                      />
                      <Button
                        data-testid="signin-submit"
                        onClick={handleLogin}
                        disabled={authBusy}
                        className="w-full h-10 bg-zinc-800 hover:bg-zinc-700 text-white"
                      >
                        {authBusy ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          "Войти"
                        )}
                      </Button>
                    </TabsContent>

                    <TabsContent value="signup" className="mt-3 space-y-2">
                      <Input
                        data-testid="signup-name"
                        placeholder="Отображаемое имя"
                        value={authDisplayName}
                        onChange={(e) => setAuthDisplayName(e.target.value)}
                        maxLength={50}
                        className="bg-zinc-950/60 border-zinc-700 text-white h-10 rounded-lg"
                      />
                      <Input
                        data-testid="signup-email"
                        type="email"
                        placeholder="E-mail"
                        value={authEmail}
                        onChange={(e) => setAuthEmail(e.target.value)}
                        className="bg-zinc-950/60 border-zinc-700 text-white h-10 rounded-lg"
                      />
                      <Input
                        data-testid="signup-password"
                        type="password"
                        placeholder="Пароль (минимум 6 символов)"
                        value={authPassword}
                        onChange={(e) => setAuthPassword(e.target.value)}
                        onKeyDown={(e) => e.key === "Enter" && handleRegister()}
                        className="bg-zinc-950/60 border-zinc-700 text-white h-10 rounded-lg"
                      />
                      <Button
                        data-testid="signup-submit"
                        onClick={handleRegister}
                        disabled={authBusy}
                        className="w-full h-10 bg-zinc-800 hover:bg-zinc-700 text-white"
                      >
                        {authBusy ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : (
                          "Создать аккаунт"
                        )}
                      </Button>
                    </TabsContent>
                  </Tabs>
                </div>
              </details>
            </>
          )}

          <Tabs defaultValue="create" className="w-full">
            <TabsList className="grid w-full grid-cols-2 bg-zinc-950/60 border border-zinc-800">
              <TabsTrigger
                value="create"
                data-testid="tab-create"
                className="data-[state=active]:bg-cyan-500 data-[state=active]:text-black"
              >
                <Plus className="w-4 h-4 mr-1.5" />
                Создать
              </TabsTrigger>
              <TabsTrigger
                value="join"
                data-testid="tab-join"
                className="data-[state=active]:bg-cyan-500 data-[state=active]:text-black"
              >
                <LogIn className="w-4 h-4 mr-1.5" />
                Войти
              </TabsTrigger>
            </TabsList>

            <TabsContent value="create" className="mt-5">
              <p className="text-sm text-zinc-400 mb-4 leading-relaxed">
                Создайте новую комнату и пригласите друзей слушать музыку
                синхронно. Поделитесь 6-значным кодом — каждый сможет
                присоединиться.
              </p>
              <Button
                data-testid="create-room-button"
                onClick={handleCreate}
                disabled={creating}
                className="w-full h-12 bg-cyan-500 text-black hover:bg-cyan-400 font-semibold rounded-lg shadow-[0_0_20px_rgba(6,182,212,0.25)] transition-all active:scale-[0.98]"
              >
                {creating ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Создать комнату
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
            </TabsContent>

            <TabsContent value="join" className="mt-5">
              <label className="block text-xs uppercase tracking-[0.1em] text-zinc-500 mb-2">
                Код комнаты
              </label>
              <Input
                data-testid="login-code-input"
                value={code}
                onChange={(e) =>
                  setCode(e.target.value.replace(/\D/g, "").slice(0, 6))
                }
                onKeyDown={(e) => e.key === "Enter" && handleJoin()}
                placeholder="123456"
                inputMode="numeric"
                maxLength={6}
                className="mono text-2xl tracking-[0.4em] text-center bg-zinc-950/60 border-zinc-700 text-white placeholder:text-zinc-700 focus-visible:ring-1 focus-visible:ring-cyan-500 focus-visible:border-cyan-500 rounded-lg h-14"
              />
              <Button
                data-testid="join-room-button"
                onClick={handleJoin}
                disabled={joining}
                className="w-full h-12 mt-4 bg-cyan-500 text-black hover:bg-cyan-400 font-semibold rounded-lg shadow-[0_0_20px_rgba(6,182,212,0.25)] transition-all active:scale-[0.98]"
              >
                {joining ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <>
                    Войти в комнату
                    <ArrowRight className="w-4 h-4 ml-2" />
                  </>
                )}
              </Button>
            </TabsContent>
          </Tabs>
        </Card>

        <p className="text-center text-xs text-zinc-600 mt-6">
          Загружайте MP3 (до 20 МБ) и слушайте вместе в реальном времени
        </p>

        <p
          className="text-center text-[11px] tracking-[0.2em] uppercase text-zinc-700 mt-3"
          data-testid="author-credit"
        >
          Разработал{" "}
          <span className="text-cyan-500/80">Даниил Осьминин</span>
        </p>
      </div>
    </div>
  );
}
