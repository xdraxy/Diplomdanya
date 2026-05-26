import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";
import {
  Music,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Upload,
  Users,
  MessageSquare,
  Send,
  LogOut,
  Copy,
  Wifi,
  WifiOff,
  Loader2,
  User,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

import { useRoomSocket } from "@/hooks/useRoomSocket";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

function formatTime(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function Room() {
  const { code } = useParams();
  const navigate = useNavigate();
  const name = useMemo(
    () => localStorage.getItem("syncplay_name") || "",
    []
  );

  // Если имя не задано — на главную
  useEffect(() => {
    if (!name) navigate("/");
  }, [name, navigate]);

  // Состояние комнаты (получаемое от сервера)
  const [roomState, setRoomState] = useState({
    track: null,
    position: 0,
    playing: false,
    volume: 0.7,
    participants: [],
    last_uploader: null,
  });
  // Метаданные последнего обновления (для расчёта drift)
  const stateMetaRef = useRef({
    serverPos: 0,
    serverPlaying: false,
    receivedAt: 0,
  });

  // UI state
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [needsUserGesture, setNeedsUserGesture] = useState(false);
  const [localTime, setLocalTime] = useState(0);
  const [seekDragging, setSeekDragging] = useState(false);

  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  const chatEndRef = useRef(null);

  const handleSocketMessage = useCallback((msg) => {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case "init": {
        applyState(msg.state, true);
        setChatMessages(msg.chat || []);
        break;
      }
      case "state":
      case "track_change":
      case "sync": {
        applyState(msg.state, msg.type === "track_change");
        break;
      }
      case "volume": {
        setRoomState((s) => ({ ...s, volume: msg.volume }));
        if (audioRef.current) audioRef.current.volume = msg.volume;
        if (msg.by && msg.by !== name) {
          toast.message(`Громкость: ${Math.round(msg.volume * 100)}%`, {
            description: `Изменил: ${msg.by}`,
          });
        }
        break;
      }
      case "participants": {
        setRoomState((s) => ({ ...s, participants: msg.participants }));
        if (msg.joined && msg.joined !== name) {
          toast.success(`${msg.joined} присоединился`);
        }
        if (msg.left && msg.left !== name) {
          toast(`${msg.left} вышел`);
        }
        break;
      }
      case "chat": {
        setChatMessages((m) => [...m, msg]);
        break;
      }
      case "error": {
        toast.error(msg.message || "Ошибка");
        if ((msg.message || "").includes("не найдена")) {
          navigate("/");
        }
        break;
      }
      default:
        break;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const { status, send } = useRoomSocket({
    code,
    name,
    onMessage: handleSocketMessage,
  });

  // Применить состояние от сервера к локальному audio
  function applyState(state, isTrackChange) {
    if (!state) return;
    setRoomState((prev) => ({
      ...prev,
      track: state.track,
      position: state.position,
      playing: state.playing,
      volume: state.volume,
      participants: state.participants,
      last_uploader: state.last_uploader,
    }));
    stateMetaRef.current = {
      serverPos: state.position || 0,
      serverPlaying: !!state.playing,
      receivedAt: performance.now() / 1000,
    };
    const audio = audioRef.current;
    if (!audio) return;

    if (state.track && state.track.url) {
      const newUrl = `${BACKEND_URL}${state.track.url}`;
      if (audio.src !== newUrl) {
        audio.src = newUrl;
        audio.load();
        setAudioReady(false);
      }
    } else {
      audio.removeAttribute("src");
      audio.load();
    }
    audio.volume = state.volume ?? 0.7;
    // currentTime установим в onLoadedMetadata либо сразу
    syncWithServer(true, isTrackChange);
  }

  function syncWithServer(force = false, isTrackChange = false) {
    const audio = audioRef.current;
    if (!audio) return;
    const meta = stateMetaRef.current;
    const elapsed = meta.serverPlaying
      ? performance.now() / 1000 - meta.receivedAt
      : 0;
    const target = meta.serverPos + elapsed;

    if (audio.duration && isFinite(audio.duration) && target > audio.duration) {
      return;
    }

    if (isFinite(audio.currentTime)) {
      const drift = Math.abs(audio.currentTime - target);
      if (force || isTrackChange || drift > 0.35) {
        try {
          audio.currentTime = Math.max(0, target);
        } catch {
          /* not seekable yet */
        }
      }
    }

    if (meta.serverPlaying) {
      if (audio.paused) {
        const p = audio.play();
        if (p && p.catch) {
          p.catch(() => setNeedsUserGesture(true));
        }
      }
    } else {
      if (!audio.paused) audio.pause();
    }
  }

  // Тик локального времени и периодическая синхронизация
  useEffect(() => {
    const id = setInterval(() => {
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        setLocalTime(audio.currentTime || 0);
      } else {
        const meta = stateMetaRef.current;
        setLocalTime(meta.serverPos || 0);
      }
      // Периодически проверяем drift
      syncWithServer(false);
    }, 200);
    return () => clearInterval(id);
  }, []);

  // Запрос полной синхронизации каждые 10 сек (на случай дрейфа)
  useEffect(() => {
    const id = setInterval(() => {
      send({ type: "sync_request" });
    }, 10000);
    return () => clearInterval(id);
  }, [send]);

  // Авто-скролл чата
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [chatMessages]);

  // Контролы плеера
  const togglePlay = () => {
    if (!roomState.track) {
      toast.error("Сначала загрузите трек");
      return;
    }
    if (needsUserGesture) {
      // Пользователь явно взаимодействует — разрешаем воспроизведение
      const audio = audioRef.current;
      if (audio) audio.play().catch(() => {});
      setNeedsUserGesture(false);
    }
    if (roomState.playing) {
      send({ type: "pause" });
    } else {
      const audio = audioRef.current;
      const pos = audio ? audio.currentTime : 0;
      send({ type: "play", position: pos });
    }
  };

  const handleSeek = (value) => {
    if (!roomState.track) return;
    const pos = value[0];
    send({ type: "seek", position: pos });
  };

  const handleVolume = (value) => {
    const v = value[0] / 100;
    setRoomState((s) => ({ ...s, volume: v }));
    if (audioRef.current) audioRef.current.volume = v;
    send({ type: "volume", volume: v });
  };

  const toggleMute = () => {
    const v = roomState.volume > 0 ? 0 : 0.7;
    handleVolume([v * 100]);
  };

  const handleSendChat = () => {
    const text = chatDraft.trim();
    if (!text) return;
    send({ type: "chat", text });
    setChatDraft("");
  };

  const handleUpload = async (file) => {
    if (!file) return;
    if (!file.name.toLowerCase().endsWith(".mp3")) {
      toast.error("Принимаются только MP3 файлы");
      return;
    }
    if (file.size > 20 * 1024 * 1024) {
      toast.error("Файл больше 20 МБ");
      return;
    }
    const form = new FormData();
    form.append("name", name);
    form.append("file", file);
    setUploading(true);
    setUploadProgress(0);
    try {
      await axios.post(`${API}/rooms/${code}/upload`, form, {
        onUploadProgress: (e) => {
          if (e.total) {
            setUploadProgress(Math.round((e.loaded * 100) / e.total));
          }
        },
      });
      toast.success("Трек загружен");
    } catch (e) {
      const detail = e?.response?.data?.detail || "Не удалось загрузить файл";
      toast.error(detail);
    } finally {
      setUploading(false);
      setUploadProgress(0);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const copyCode = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Код скопирован");
    } catch {
      toast.error("Не удалось скопировать");
    }
  };

  const leaveRoom = () => {
    navigate("/");
  };

  const duration = roomState.track?.duration || 0;
  const volumePct = Math.round(roomState.volume * 100);

  return (
    <div
      className="app-bg grid-bg min-h-screen flex flex-col"
      data-testid="room-page"
    >
      {/* Скрытый audio */}
      <audio
        ref={audioRef}
        preload="auto"
        onLoadedMetadata={() => {
          setAudioReady(true);
          syncWithServer(true);
        }}
        onCanPlay={() => syncWithServer(false)}
        onEnded={() => {
          send({ type: "pause" });
        }}
      />

      {/* Шапка */}
      <header
        className="flex flex-wrap items-center justify-between gap-3 px-4 md:px-6 py-3 bg-zinc-900/60 backdrop-blur-md border-b border-zinc-800"
        data-testid="room-header"
      >
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-lg bg-cyan-500/10 border border-cyan-500/30 flex items-center justify-center">
            <Music className="w-4 h-4 text-cyan-400" />
          </div>
          <div>
            <div className="text-xs uppercase tracking-[0.15em] text-zinc-500">
              Комната
            </div>
            <div className="flex items-center gap-2">
              <span
                className="mono text-xl font-black tracking-[0.2em] text-white"
                data-testid="room-code-display"
              >
                {code}
              </span>
              <Button
                size="icon"
                variant="ghost"
                onClick={copyCode}
                className="h-7 w-7 text-zinc-500 hover:text-cyan-400 hover:bg-white/5"
                data-testid="copy-code-button"
                title="Скопировать код"
              >
                <Copy className="w-3.5 h-3.5" />
              </Button>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <div
            className="hidden sm:flex items-center gap-2 px-3 py-1.5 rounded-full bg-zinc-950/60 border border-zinc-800"
            data-testid="connection-status"
          >
            {status === "connected" ? (
              <>
                <span className="w-2 h-2 rounded-full bg-emerald-400 sync-dot" />
                <Wifi className="w-3.5 h-3.5 text-emerald-400" />
                <span className="text-xs text-zinc-400">Синхронизировано</span>
              </>
            ) : status === "connecting" ? (
              <>
                <Loader2 className="w-3.5 h-3.5 text-amber-400 animate-spin" />
                <span className="text-xs text-amber-400">Подключение...</span>
              </>
            ) : (
              <>
                <WifiOff className="w-3.5 h-3.5 text-red-400" />
                <span className="text-xs text-red-400">Нет связи</span>
              </>
            )}
          </div>

          <Badge
            variant="outline"
            className="bg-zinc-950/60 border-zinc-800 text-zinc-300"
          >
            <User className="w-3 h-3 mr-1.5" />
            {name}
          </Badge>

          <Button
            variant="ghost"
            size="sm"
            onClick={leaveRoom}
            data-testid="leave-room-button"
            className="text-zinc-400 hover:text-red-400 hover:bg-red-500/10"
          >
            <LogOut className="w-4 h-4 mr-1.5" />
            Выйти
          </Button>
        </div>
      </header>

      {/* Основная сетка */}
      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 min-h-0">
        {/* Плеер */}
        <section
          className="lg:col-span-8 flex flex-col gap-4 fade-up"
          data-testid="player-section"
        >
          <Card className="flex-1 bg-zinc-900/40 border-zinc-800 rounded-2xl p-6 md:p-10 relative overflow-hidden flex flex-col">
            {/* Декор */}
            <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
            <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-blue-500/5 blur-3xl pointer-events-none" />

            <div className="relative flex-1 flex flex-col items-center justify-center">
              {/* Обложка */}
              <div
                className="w-48 h-48 md:w-64 md:h-64 rounded-2xl border border-white/10 shadow-2xl flex items-center justify-center overflow-hidden bg-gradient-to-br from-zinc-800 to-zinc-950 relative"
                data-testid="cover-art"
              >
                {roomState.track?.cover_url ? (
                  <img
                    src={`${BACKEND_URL}${roomState.track.cover_url}`}
                    alt="Обложка"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <Music className="w-20 h-20 text-zinc-700" />
                )}
                {roomState.playing && (
                  <div className="absolute bottom-3 right-3 p-2 rounded-full bg-black/60 backdrop-blur-sm">
                    <span className="eq-bars">
                      <span />
                      <span />
                      <span />
                      <span />
                    </span>
                  </div>
                )}
              </div>

              {/* Метаданные */}
              <div className="text-center mt-6 space-y-1 max-w-lg">
                <div className="text-xs uppercase tracking-[0.2em] text-zinc-500">
                  {roomState.track ? "Сейчас играет" : "Трек не выбран"}
                </div>
                <h2
                  className="text-2xl md:text-3xl font-bold text-white truncate"
                  data-testid="track-title"
                >
                  {roomState.track?.title || "—"}
                </h2>
                <p className="text-base text-zinc-400 truncate">
                  {roomState.track?.artist || "Загрузите MP3, чтобы начать"}
                </p>
                {roomState.track?.uploaded_by && (
                  <p className="text-xs text-zinc-600 pt-1">
                    Загрузил:{" "}
                    <span className="text-cyan-400">
                      {roomState.track.uploaded_by}
                    </span>
                  </p>
                )}
              </div>

              {/* Seek */}
              <div className="w-full max-w-2xl mt-8">
                <Slider
                  data-testid="seek-slider"
                  disabled={!roomState.track || !audioReady}
                  value={[Math.min(localTime, duration || 0)]}
                  max={duration || 1}
                  step={0.1}
                  onValueChange={(v) => {
                    setSeekDragging(true);
                    setLocalTime(v[0]);
                  }}
                  onValueCommit={(v) => {
                    setSeekDragging(false);
                    handleSeek(v);
                  }}
                />
                <div className="flex justify-between mt-2 mono text-sm text-cyan-400">
                  <span data-testid="current-time">{formatTime(localTime)}</span>
                  <span className="text-zinc-600">
                    {formatTime(duration)}
                  </span>
                </div>
              </div>

              {/* Контролы */}
              <div className="flex items-center justify-center gap-6 mt-8">
                <Button
                  data-testid="upload-track-button"
                  variant="secondary"
                  size="icon"
                  onClick={() => fileInputRef.current?.click()}
                  disabled={uploading}
                  className="w-12 h-12 rounded-full bg-zinc-800 hover:bg-zinc-700 text-white border border-zinc-700"
                  title="Загрузить трек"
                >
                  {uploading ? (
                    <Loader2 className="w-5 h-5 animate-spin" />
                  ) : (
                    <Upload className="w-5 h-5" />
                  )}
                </Button>

                <Button
                  data-testid="play-pause-button"
                  onClick={togglePlay}
                  className="w-16 h-16 rounded-full bg-cyan-500 hover:bg-cyan-400 text-black shadow-[0_0_25px_rgba(6,182,212,0.45)] hover:scale-105 active:scale-95 transition-transform"
                >
                  {roomState.playing ? (
                    <Pause className="w-6 h-6" fill="currentColor" />
                  ) : (
                    <Play className="w-6 h-6 ml-0.5" fill="currentColor" />
                  )}
                </Button>

                <div className="flex items-center gap-2 w-32 sm:w-40">
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={toggleMute}
                    className="text-zinc-400 hover:text-white shrink-0"
                    data-testid="mute-button"
                  >
                    {volumePct === 0 ? (
                      <VolumeX className="w-5 h-5" />
                    ) : (
                      <Volume2 className="w-5 h-5" />
                    )}
                  </Button>
                  <Slider
                    data-testid="volume-slider"
                    value={[volumePct]}
                    max={100}
                    step={1}
                    onValueChange={handleVolume}
                  />
                </div>
              </div>

              {/* Прогресс загрузки */}
              {uploading && (
                <div className="w-full max-w-md mt-6">
                  <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
                    <span>Загрузка трека...</span>
                    <span className="mono text-cyan-400">
                      {uploadProgress}%
                    </span>
                  </div>
                  <Progress
                    value={uploadProgress}
                    className="h-1.5 bg-zinc-800"
                    data-testid="upload-progress"
                  />
                </div>
              )}

              {needsUserGesture && (
                <div className="mt-4 text-xs text-amber-400">
                  Нажмите Play для разблокировки звука
                </div>
              )}
            </div>

            <input
              ref={fileInputRef}
              type="file"
              accept=".mp3,audio/mpeg"
              className="hidden-file-input"
              onChange={(e) => handleUpload(e.target.files?.[0])}
              data-testid="upload-track-input"
            />
          </Card>
        </section>

        {/* Боковая панель: участники + чат */}
        <aside
          className="lg:col-span-4 flex flex-col gap-4 min-h-0 fade-up"
          data-testid="sidebar"
        >
          <Tabs defaultValue="chat" className="flex-1 flex flex-col min-h-0">
            <TabsList className="grid grid-cols-2 bg-zinc-900/60 border border-zinc-800">
              <TabsTrigger
                value="chat"
                data-testid="tab-chat"
                className="data-[state=active]:bg-cyan-500 data-[state=active]:text-black"
              >
                <MessageSquare className="w-4 h-4 mr-1.5" />
                Чат
              </TabsTrigger>
              <TabsTrigger
                value="participants"
                data-testid="tab-participants"
                className="data-[state=active]:bg-cyan-500 data-[state=active]:text-black"
              >
                <Users className="w-4 h-4 mr-1.5" />
                Участники
                <span className="ml-1.5 text-xs opacity-70">
                  {roomState.participants.length}
                </span>
              </TabsTrigger>
            </TabsList>

            <TabsContent
              value="chat"
              className="flex-1 mt-3 min-h-0 flex flex-col"
            >
              <Card className="flex-1 bg-zinc-900/50 border-zinc-800 rounded-xl flex flex-col min-h-[400px] lg:min-h-0 overflow-hidden">
                <ScrollArea className="flex-1 px-4 py-3" data-testid="chat-scroll">
                  <div className="flex flex-col gap-2.5">
                    {chatMessages.length === 0 ? (
                      <div className="text-center text-sm text-zinc-600 py-12">
                        Сообщений пока нет
                      </div>
                    ) : (
                      chatMessages.map((m, i) => {
                        const mine = m.name === name;
                        return (
                          <div
                            key={i}
                            className={`flex ${mine ? "justify-end" : "justify-start"}`}
                          >
                            <div
                              className={`max-w-[80%] rounded-2xl px-3 py-2 ${
                                mine
                                  ? "bg-cyan-500 text-black rounded-br-sm"
                                  : "bg-zinc-800 text-zinc-100 rounded-bl-sm"
                              }`}
                            >
                              {!mine && (
                                <div className="text-[10px] uppercase tracking-wide font-semibold text-cyan-400 mb-0.5">
                                  {m.name}
                                </div>
                              )}
                              <div className="text-sm break-words whitespace-pre-wrap">
                                {m.text}
                              </div>
                            </div>
                          </div>
                        );
                      })
                    )}
                    <div ref={chatEndRef} />
                  </div>
                </ScrollArea>
                <div className="flex items-center gap-2 p-3 border-t border-zinc-800 bg-zinc-950/40">
                  <Input
                    data-testid="chat-message-input"
                    value={chatDraft}
                    onChange={(e) => setChatDraft(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        handleSendChat();
                      }
                    }}
                    placeholder="Введите сообщение..."
                    maxLength={500}
                    className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-cyan-500 focus-visible:border-cyan-500 rounded-lg h-10"
                  />
                  <Button
                    data-testid="chat-send-button"
                    onClick={handleSendChat}
                    size="icon"
                    className="bg-cyan-500 hover:bg-cyan-400 text-black shrink-0 h-10 w-10 rounded-lg"
                  >
                    <Send className="w-4 h-4" />
                  </Button>
                </div>
              </Card>
            </TabsContent>

            <TabsContent value="participants" className="flex-1 mt-3 min-h-0">
              <Card className="bg-zinc-900/50 border-zinc-800 rounded-xl p-4 h-full overflow-hidden flex flex-col">
                <ScrollArea className="flex-1" data-testid="participants-scroll">
                  <ul className="flex flex-col gap-2">
                    {roomState.participants.length === 0 ? (
                      <li className="text-center text-sm text-zinc-600 py-8">
                        Никого нет
                      </li>
                    ) : (
                      roomState.participants.map((p, i) => (
                        <li
                          key={`${p}-${i}`}
                          className="flex items-center gap-3 px-2 py-2 rounded-lg hover:bg-zinc-800/50 transition-colors"
                          data-testid="participant-row"
                        >
                          <Avatar className="h-8 w-8 border border-cyan-900">
                            <AvatarFallback className="bg-zinc-800 text-cyan-400 mono text-xs">
                              {initials(p)}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="text-sm text-zinc-100 truncate">
                              {p}
                              {p === name && (
                                <span className="text-zinc-500 ml-1.5 text-xs">
                                  (вы)
                                </span>
                              )}
                            </div>
                            {roomState.last_uploader === p && (
                              <div className="text-[10px] uppercase tracking-wider text-cyan-500">
                                загрузил трек
                              </div>
                            )}
                          </div>
                        </li>
                      ))
                    )}
                  </ul>
                </ScrollArea>
              </Card>
            </TabsContent>
          </Tabs>
        </aside>
      </main>
    </div>
  );
}
