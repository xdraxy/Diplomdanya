import { useRef } from "react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { ListMusic, Plus, X, Loader2 } from "lucide-react";

function formatTime(sec) {
  if (!sec || !isFinite(sec)) return "0:00";
  const s = Math.floor(sec);
  const m = Math.floor(s / 60);
  return `${m}:${(s % 60).toString().padStart(2, "0")}`;
}

export default function QueuePanel({
  queue,
  uploading,
  onAddToQueue,
  onRemove,
}) {
  const inputRef = useRef(null);
  return (
    <Card className="bg-zinc-900/50 border-zinc-800 rounded-xl p-4 h-full overflow-hidden flex flex-col min-h-[400px] lg:min-h-0">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2 text-xs uppercase tracking-[0.15em] text-zinc-400">
          <ListMusic className="w-3.5 h-3.5 text-cyan-400" />
          Очередь
          <span className="text-zinc-600">·</span>
          <span className="text-cyan-500">{queue.length}</span>
        </div>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="text-cyan-400 hover:text-cyan-300 hover:bg-cyan-500/10 h-7"
          data-testid="queue-add-button"
        >
          {uploading ? (
            <Loader2 className="w-3.5 h-3.5 animate-spin" />
          ) : (
            <>
              <Plus className="w-3.5 h-3.5 mr-1" />
              Добавить
            </>
          )}
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".mp3,audio/mpeg"
          className="hidden-file-input"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onAddToQueue(f);
            e.target.value = "";
          }}
          data-testid="queue-add-input"
        />
      </div>

      <ScrollArea className="flex-1" data-testid="queue-scroll">
        <ul className="flex flex-col gap-1.5">
          {queue.length === 0 ? (
            <li className="text-center text-sm text-zinc-600 py-12">
              Очередь пуста.
              <br />
              <span className="text-xs text-zinc-700">
                Добавьте треки — они заиграют по очереди.
              </span>
            </li>
          ) : (
            queue.map((q, idx) => (
              <li
                key={q.id}
                className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-zinc-800/50 transition-colors group"
                data-testid="queue-row"
              >
                <div className="w-6 h-6 rounded bg-zinc-800 flex items-center justify-center text-[10px] text-cyan-500 mono shrink-0">
                  {idx + 1}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-sm text-zinc-100 truncate">
                    {q.title}
                  </div>
                  <div className="text-[11px] text-zinc-500 truncate">
                    {q.artist}
                    {q.duration ? (
                      <>
                        {" · "}
                        <span className="mono">{formatTime(q.duration)}</span>
                      </>
                    ) : null}
                  </div>
                </div>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => onRemove(q.id)}
                  className="h-7 w-7 text-zinc-500 hover:text-red-400 opacity-0 group-hover:opacity-100 transition-opacity"
                  data-testid="queue-remove-button"
                  title="Убрать из очереди"
                >
                  <X className="w-3.5 h-3.5" />
                </Button>
              </li>
            ))
          )}
        </ul>
      </ScrollArea>
    </Card>
  );
}
