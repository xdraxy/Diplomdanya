import { useEffect, useRef, useState, useCallback, useMemo } from "react";
import { useParams, useNavigate } from "react-router-dom";
import axios from "axios";
import { toast } from "sonner";

import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Users, MessageSquare } from "lucide-react";

import { useRoomSocket } from "@/hooks/useRoomSocket";
import RoomHeader from "@/components/room/RoomHeader";
import AudioPlayer from "@/components/room/AudioPlayer";
import ChatPanel from "@/components/room/ChatPanel";
import ParticipantsList from "@/components/room/ParticipantsList";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";
const API = `${BACKEND_URL}/api`;

const INITIAL_STATE = {
  track: null,
  position: 0,
  playing: false,
  volume: 0.7,
  participants: [],
  last_uploader: null,
};

export default function Room() {
  const { code } = useParams();
  const navigate = useNavigate();
  const name = useMemo(
    () => localStorage.getItem("syncplay_name") || "",
    []
  );

  useEffect(() => {
    if (!name) navigate("/");
  }, [name, navigate]);

  const [roomState, setRoomState] = useState(INITIAL_STATE);
  const [chatMessages, setChatMessages] = useState([]);
  const [chatDraft, setChatDraft] = useState("");
  const [uploadProgress, setUploadProgress] = useState(0);
  const [uploading, setUploading] = useState(false);
  const [audioReady, setAudioReady] = useState(false);
  const [needsUserGesture, setNeedsUserGesture] = useState(false);
  const [localTime, setLocalTime] = useState(0);
  // Когда пользователь тащит ползунок перемотки, локальный «тик» не должен
  // перезаписывать localTime значением audio.currentTime — иначе ползунок
  // прыгает обратно.
  const seekDraggingRef = useRef(false);

  const audioRef = useRef(null);
  const fileInputRef = useRef(null);
  // Хранит URL, который мы реально загружали в <audio>. Сравниваем с ним,
  // а не с audio.src — браузер нормализует/меняет audio.src, из-за чего
  // следующий applyState может ошибочно посчитать URL изменившимся и
  // перезагрузить трек (сброс currentTime → 0).
  const loadedSrcRef = useRef(null);
  const stateMetaRef = useRef({
    serverPos: 0,
    serverPlaying: false,
    receivedAt: 0,
  });

  // ---- sync logic ----
  // Корректируем audio.currentTime только если расхождение > 0.2 с
  // (порог из спецификации), чтобы избежать «дёрганий».
  const syncWithServer = useCallback((force = false, isTrackChange = false) => {
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
      if (force || isTrackChange || drift > 0.2) {
        try {
          audio.currentTime = Math.max(0, target);
        } catch (err) {
          console.warn("Room: seek failed (not seekable yet)", err);
        }
      }
    }
    if (meta.serverPlaying) {
      if (audio.paused) {
        const p = audio.play();
        if (p && p.catch) {
          p.catch((err) => {
            console.warn("Room: autoplay blocked, awaiting user gesture", err);
            setNeedsUserGesture(true);
          });
        }
      }
    } else if (!audio.paused) {
      audio.pause();
    }
  }, []);

  const applyState = useCallback(
    (state, isTrackChange) => {
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
        // Перезагружаем audio только если URL РЕАЛЬНО другой
        // (сравнение через loadedSrcRef, а не audio.src).
        if (loadedSrcRef.current !== newUrl) {
          loadedSrcRef.current = newUrl;
          audio.src = newUrl;
          audio.load();
          setAudioReady(false);
        }
      } else {
        loadedSrcRef.current = null;
        audio.removeAttribute("src");
        audio.load();
      }
      audio.volume = state.volume ?? 0.7;
      syncWithServer(true, isTrackChange);
    },
    [syncWithServer]
  );

  const handleSocketMessage = useCallback(
    (msg) => {
      if (!msg || !msg.type) return;
      switch (msg.type) {
        case "init":
          applyState(msg.state, true);
          setChatMessages(msg.chat || []);
          break;
        case "state":
        case "track_change":
        case "sync":
          applyState(msg.state, msg.type === "track_change");
          break;
        case "volume":
          setRoomState((s) => ({ ...s, volume: msg.volume }));
          if (audioRef.current) audioRef.current.volume = msg.volume;
          if (msg.by && msg.by !== name) {
            toast.message(`Громкость: ${Math.round(msg.volume * 100)}%`, {
              description: `Изменил: ${msg.by}`,
            });
          }
          break;
        case "participants":
          setRoomState((s) => ({ ...s, participants: msg.participants }));
          if (msg.joined && msg.joined !== name) {
            toast.success(`${msg.joined} присоединился`);
          }
          if (msg.left && msg.left !== name) {
            toast(`${msg.left} вышел`);
          }
          break;
        case "chat":
          setChatMessages((m) => [...m, msg]);
          break;
        case "error":
          toast.error(msg.message || "Ошибка");
          if ((msg.message || "").includes("не найдена")) {
            navigate("/");
          }
          break;
        default:
          break;
      }
    },
    [applyState, name, navigate]
  );

  const { status, send } = useRoomSocket({
    code,
    name,
    onMessage: handleSocketMessage,
  });

  // Tick + drift correction
  // Не обновляем localTime, пока пользователь тащит ползунок перемотки.
  useEffect(() => {
    const id = setInterval(() => {
      if (seekDraggingRef.current) {
        // во время перетаскивания позиция управляется пользователем —
        // ни локальное время, ни автоматический drift-correction не трогаем
        return;
      }
      const audio = audioRef.current;
      if (audio && !audio.paused) {
        setLocalTime(audio.currentTime || 0);
      } else {
        setLocalTime(stateMetaRef.current.serverPos || 0);
      }
      syncWithServer(false);
    }, 200);
    return () => clearInterval(id);
  }, [syncWithServer]);

  // Periodic full re-sync
  useEffect(() => {
    const id = setInterval(() => send({ type: "sync_request" }), 10000);
    return () => clearInterval(id);
  }, [send]);

  // ---- handlers ----
  // Оптимистично обновляем stateMetaRef, чтобы следующий 200-мс тик не
  // «откатывал» локальные изменения до прихода ответа от сервера.
  const togglePlay = useCallback(() => {
    if (!roomState.track) {
      toast.error("Сначала загрузите трек");
      return;
    }
    if (needsUserGesture) {
      const audio = audioRef.current;
      if (audio) {
        audio.play().catch((err) => {
          console.warn("Room: play after gesture still blocked", err);
        });
      }
      setNeedsUserGesture(false);
    }
    const audio = audioRef.current;
    if (roomState.playing) {
      const pos = audio ? audio.currentTime : stateMetaRef.current.serverPos;
      stateMetaRef.current = {
        serverPos: pos,
        serverPlaying: false,
        receivedAt: performance.now() / 1000,
      };
      if (audio && !audio.paused) audio.pause();
      setRoomState((s) => ({ ...s, playing: false, position: pos }));
      send({ type: "pause" });
    } else {
      const pos = audio ? audio.currentTime : 0;
      stateMetaRef.current = {
        serverPos: pos,
        serverPlaying: true,
        receivedAt: performance.now() / 1000,
      };
      if (audio && audio.paused) {
        audio.play().catch((err) => {
          console.warn("Room: play blocked", err);
          setNeedsUserGesture(true);
        });
      }
      setRoomState((s) => ({ ...s, playing: true, position: pos }));
      send({ type: "play", position: pos });
    }
  }, [roomState.track, roomState.playing, needsUserGesture, send]);

  const handleSeekPreview = useCallback((v) => {
    // помечаем, что пользователь тащит ползунок, и обновляем визуальное
    // положение без трогания audio.currentTime
    seekDraggingRef.current = true;
    setLocalTime(v[0]);
  }, []);

  const handleSeekCommit = useCallback(
    (v) => {
      seekDraggingRef.current = false;
      if (!roomState.track) return;
      const target = v[0];
      // КРИТИЧНО: оптимистично обновляем stateMetaRef ПЕРЕД отправкой seek
      // на сервер. Иначе ближайший 200-мс тик сравнит audio.currentTime
      // (новое значение) с target, посчитанным по СТАРОМУ play_started_at,
      // увидит drift > 0.2с и откатит перемотку.
      stateMetaRef.current = {
        serverPos: target,
        serverPlaying: !!roomState.playing,
        receivedAt: performance.now() / 1000,
      };
      // Локальный seek для мгновенного отклика
      const audio = audioRef.current;
      if (audio) {
        try {
          const max = isFinite(audio.duration)
            ? audio.duration
            : roomState.track.duration || target;
          audio.currentTime = Math.max(0, Math.min(target, max));
        } catch (err) {
          console.warn("Room: local seek failed", err);
        }
      }
      setLocalTime(target);
      send({ type: "seek", position: target });
    },
    [roomState.track, roomState.playing, send]
  );

  const handleVolume = useCallback(
    (v) => {
      const value = v[0] / 100;
      setRoomState((s) => ({ ...s, volume: value }));
      if (audioRef.current) audioRef.current.volume = value;
      send({ type: "volume", volume: value });
    },
    [send]
  );

  const handleMute = useCallback(() => {
    const v = roomState.volume > 0 ? 0 : 0.7;
    handleVolume([v * 100]);
  }, [roomState.volume, handleVolume]);

  const handleSendChat = useCallback(() => {
    const text = chatDraft.trim();
    if (!text) return;
    send({ type: "chat", text });
    setChatDraft("");
  }, [chatDraft, send]);

  const handleUpload = useCallback(
    async (file) => {
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
        console.warn("Room: upload failed", e);
        const detail = e?.response?.data?.detail || "Не удалось загрузить файл";
        toast.error(detail);
      } finally {
        setUploading(false);
        setUploadProgress(0);
        if (fileInputRef.current) fileInputRef.current.value = "";
      }
    },
    [code, name]
  );

  const handleCopyCode = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast.success("Код скопирован");
    } catch (err) {
      console.warn("Room: clipboard write failed", err);
      toast.error("Не удалось скопировать");
    }
  }, [code]);

  const handleLeave = useCallback(() => navigate("/"), [navigate]);

  const handleUploadClick = useCallback(
    () => fileInputRef.current?.click(),
    []
  );

  const handleAudioLoadedMetadata = useCallback(() => {
    setAudioReady(true);
    syncWithServer(true);
  }, [syncWithServer]);

  const handleAudioCanPlay = useCallback(
    () => syncWithServer(false),
    [syncWithServer]
  );

  // При окончании трека: оптимистично обновляем локальное состояние, чтобы
  // тик не пытался снова запустить воспроизведение до ответа сервера.
  const handleAudioEnded = useCallback(() => {
    const dur = audioRef.current?.duration || 0;
    stateMetaRef.current = {
      serverPos: dur,
      serverPlaying: false,
      receivedAt: performance.now() / 1000,
    };
    setRoomState((s) => ({ ...s, playing: false, position: dur }));
    send({ type: "pause" });
  }, [send]);

  return (
    <div className="app-bg grid-bg min-h-screen flex flex-col" data-testid="room-page">
      <audio
        ref={audioRef}
        preload="auto"
        onLoadedMetadata={handleAudioLoadedMetadata}
        onCanPlay={handleAudioCanPlay}
        onEnded={handleAudioEnded}
      />

      <RoomHeader
        code={code}
        name={name}
        status={status}
        onCopyCode={handleCopyCode}
        onLeave={handleLeave}
      />

      <main className="flex-1 grid grid-cols-1 lg:grid-cols-12 gap-4 p-4 min-h-0">
        <section className="lg:col-span-8 flex flex-col gap-4 fade-up" data-testid="player-section">
          <AudioPlayer
            track={roomState.track}
            playing={roomState.playing}
            volume={roomState.volume}
            localTime={localTime}
            audioReady={audioReady}
            needsUserGesture={needsUserGesture}
            uploading={uploading}
            uploadProgress={uploadProgress}
            onTogglePlay={togglePlay}
            onSeek={handleSeekCommit}
            onSeekPreview={handleSeekPreview}
            onVolume={handleVolume}
            onMute={handleMute}
            onUploadClick={handleUploadClick}
          />
          <input
            ref={fileInputRef}
            type="file"
            accept=".mp3,audio/mpeg"
            className="hidden-file-input"
            onChange={(e) => handleUpload(e.target.files?.[0])}
            data-testid="upload-track-input"
          />
        </section>

        <aside className="lg:col-span-4 flex flex-col gap-4 min-h-0 fade-up" data-testid="sidebar">
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

            <TabsContent value="chat" className="flex-1 mt-3 min-h-0 flex flex-col">
              <ChatPanel
                messages={chatMessages}
                myName={name}
                draft={chatDraft}
                onDraftChange={setChatDraft}
                onSend={handleSendChat}
              />
            </TabsContent>

            <TabsContent value="participants" className="flex-1 mt-3 min-h-0">
              <ParticipantsList
                participants={roomState.participants}
                myName={name}
                lastUploader={roomState.last_uploader}
              />
            </TabsContent>
          </Tabs>
        </aside>
      </main>
    </div>
  );
}
