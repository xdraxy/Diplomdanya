import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Music, Copy, Wifi, WifiOff, Loader2, LogOut, User } from "lucide-react";

export default function RoomHeader({ code, name, status, onCopyCode, onLeave }) {
  return (
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
              onClick={onCopyCode}
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
          onClick={onLeave}
          data-testid="leave-room-button"
          className="text-zinc-400 hover:text-red-400 hover:bg-red-500/10"
        >
          <LogOut className="w-4 h-4 mr-1.5" />
          Выйти
        </Button>
      </div>
    </header>
  );
}
