import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Slider } from "@/components/ui/slider";
import { Progress } from "@/components/ui/progress";
import {
  Music,
  Play,
  Pause,
  Volume2,
  VolumeX,
  Upload,
  Loader2,
} from "lucide-react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";

function formatTime(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export default function AudioPlayer({
  track,
  playing,
  volume,
  localTime,
  audioReady,
  needsUserGesture,
  uploading,
  uploadProgress,
  onTogglePlay,
  onSeek,
  onSeekPreview,
  onVolume,
  onMute,
  onUploadClick,
}) {
  const duration = track?.duration || 0;
  const volumePct = Math.round(volume * 100);
  const seekValue = [Math.min(localTime, duration || 0)];
  const volumeValue = [volumePct];

  return (
    <Card className="flex-1 bg-zinc-900/40 border-zinc-800 rounded-2xl p-6 md:p-10 relative overflow-hidden flex flex-col">
      <div className="absolute -top-32 -right-32 w-96 h-96 rounded-full bg-cyan-500/10 blur-3xl pointer-events-none" />
      <div className="absolute -bottom-32 -left-32 w-96 h-96 rounded-full bg-blue-500/5 blur-3xl pointer-events-none" />

      <div className="relative flex-1 flex flex-col items-center justify-center">
        {/* Обложка */}
        <div
          className="w-48 h-48 md:w-64 md:h-64 rounded-2xl border border-white/10 shadow-2xl flex items-center justify-center overflow-hidden bg-gradient-to-br from-zinc-800 to-zinc-950 relative"
          data-testid="cover-art"
        >
          {track?.cover_url ? (
            <img
              src={`${BACKEND_URL}${track.cover_url}`}
              alt="Обложка"
              className="w-full h-full object-cover"
            />
          ) : (
            <Music className="w-20 h-20 text-zinc-700" />
          )}
          {playing && (
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
            {track ? "Сейчас играет" : "Трек не выбран"}
          </div>
          <h2
            className="text-2xl md:text-3xl font-bold text-white truncate"
            data-testid="track-title"
          >
            {track?.title || "—"}
          </h2>
          <p className="text-base text-zinc-400 truncate">
            {track?.artist || "Загрузите MP3, чтобы начать"}
          </p>
          {track?.uploaded_by && (
            <p className="text-xs text-zinc-600 pt-1">
              Загрузил:{" "}
              <span className="text-cyan-400">{track.uploaded_by}</span>
            </p>
          )}
        </div>

        {/* Seek */}
        <div className="w-full max-w-2xl mt-8">
          <Slider
            data-testid="seek-slider"
            disabled={!track || !audioReady}
            value={seekValue}
            max={duration || 1}
            step={0.1}
            onValueChange={onSeekPreview}
            onValueCommit={onSeek}
          />
          <div className="flex justify-between mt-2 mono text-sm text-cyan-400">
            <span data-testid="current-time">{formatTime(localTime)}</span>
            <span className="text-zinc-600">{formatTime(duration)}</span>
          </div>
        </div>

        {/* Контролы */}
        <div className="flex items-center justify-center gap-6 mt-8">
          <Button
            data-testid="upload-track-button"
            variant="secondary"
            size="icon"
            onClick={onUploadClick}
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
            onClick={onTogglePlay}
            className="w-16 h-16 rounded-full bg-cyan-500 hover:bg-cyan-400 text-black shadow-[0_0_25px_rgba(6,182,212,0.45)] hover:scale-105 active:scale-95 transition-transform"
          >
            {playing ? (
              <Pause className="w-6 h-6" fill="currentColor" />
            ) : (
              <Play className="w-6 h-6 ml-0.5" fill="currentColor" />
            )}
          </Button>

          <div className="flex items-center gap-2 w-32 sm:w-40">
            <Button
              variant="ghost"
              size="icon"
              onClick={onMute}
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
              value={volumeValue}
              max={100}
              step={1}
              onValueChange={onVolume}
            />
          </div>
        </div>

        {uploading && (
          <div className="w-full max-w-md mt-6">
            <div className="flex justify-between text-xs text-zinc-400 mb-1.5">
              <span>Загрузка трека...</span>
              <span className="mono text-cyan-400">{uploadProgress}%</span>
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
    </Card>
  );
}
