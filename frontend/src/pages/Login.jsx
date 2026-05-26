import { useState } from "react";
import { useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import { Music, ArrowRight, Loader2, Plus, LogIn } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card } from "@/components/ui/card";

const API = `${process.env.REACT_APP_BACKEND_URL}/api`;

const NAME_REGEX = /^[a-zA-Zа-яА-ЯёЁ0-9 .\-_]+$/;

export default function Login() {
  const navigate = useNavigate();
  const [name, setName] = useState(
    () => localStorage.getItem("syncplay_name") || ""
  );
  const [code, setCode] = useState("");
  const [creating, setCreating] = useState(false);
  const [joining, setJoining] = useState(false);

  const validateName = () => {
    const trimmed = name.trim();
    if (trimmed.length < 2) {
      toast.error("Введите имя минимум из 2 символов");
      return null;
    }
    if (!NAME_REGEX.test(trimmed)) {
      toast.error("Имя может содержать только русские/английские буквы и цифры");
      return null;
    }
    return trimmed;
  };

  const handleCreate = async () => {
    const validName = validateName();
    if (!validName) return;
    setCreating(true);
    try {
      const { data } = await axios.post(`${API}/rooms`);
      localStorage.setItem("syncplay_name", validName);
      toast.success(`Комната создана: ${data.code}`);
      navigate(`/room/${data.code}`);
    } catch (e) {
      toast.error("Не удалось создать комнату");
    } finally {
      setCreating(false);
    }
  };

  const handleJoin = async () => {
    const validName = validateName();
    if (!validName) return;
    const clean = code.replace(/\D/g, "");
    if (clean.length !== 6) {
      toast.error("Код комнаты должен состоять из 6 цифр");
      return;
    }
    setJoining(true);
    try {
      await axios.get(`${API}/rooms/${clean}`);
      localStorage.setItem("syncplay_name", validName);
      navigate(`/room/${clean}`);
    } catch (e) {
      if (e?.response?.status === 404) {
        toast.error("Комната не найдена");
      } else {
        toast.error("Не удалось войти в комнату");
      }
    } finally {
      setJoining(false);
    }
  };

  return (
    <div
      className="app-bg grid-bg min-h-screen flex items-center justify-center px-4 py-12"
      data-testid="login-page"
    >
      <div className="w-full max-w-md fade-up">
        {/* Логотип / Заголовок */}
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

        <Card className="bg-zinc-900/70 backdrop-blur-md border border-zinc-800 rounded-2xl shadow-2xl p-6">
          <div className="mb-5">
            <label className="block text-xs uppercase tracking-[0.1em] text-zinc-500 mb-2">
              Ваше имя
            </label>
            <Input
              data-testid="login-name-input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Например, Алексей"
              maxLength={50}
              className="bg-zinc-950/60 border-zinc-700 text-white placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-cyan-500 focus-visible:border-cyan-500 rounded-lg h-12"
            />
            <p className="mt-1.5 text-xs text-zinc-500">
              Русские/английские буквы, цифры
            </p>
          </div>

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
                onKeyDown={(e) => {
                  if (e.key === "Enter") handleJoin();
                }}
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
      </div>
    </div>
  );
}
