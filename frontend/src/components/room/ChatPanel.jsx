import { useEffect, useRef } from "react";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Send } from "lucide-react";

export default function ChatPanel({
  messages,
  myName,
  draft,
  onDraftChange,
  onSend,
}) {
  const endRef = useRef(null);

  useEffect(() => {
    if (endRef.current) {
      endRef.current.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [messages]);

  return (
    <Card className="flex-1 bg-zinc-900/50 border-zinc-800 rounded-xl flex flex-col min-h-[400px] lg:min-h-0 overflow-hidden">
      <ScrollArea className="flex-1 px-4 py-3" data-testid="chat-scroll">
        <div className="flex flex-col gap-2.5">
          {messages.length === 0 ? (
            <div className="text-center text-sm text-zinc-600 py-12">
              Сообщений пока нет
            </div>
          ) : (
            messages.map((m) => {
              const mine = m.name === myName;
              return (
                <div
                  key={`${m.ts}-${m.name}`}
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
          <div ref={endRef} />
        </div>
      </ScrollArea>
      <div className="flex items-center gap-2 p-3 border-t border-zinc-800 bg-zinc-950/40">
        <Input
          data-testid="chat-message-input"
          value={draft}
          onChange={(e) => onDraftChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              onSend();
            }
          }}
          placeholder="Введите сообщение..."
          maxLength={500}
          className="bg-zinc-900 border-zinc-700 text-white placeholder:text-zinc-500 focus-visible:ring-1 focus-visible:ring-cyan-500 focus-visible:border-cyan-500 rounded-lg h-10"
        />
        <Button
          data-testid="chat-send-button"
          onClick={onSend}
          size="icon"
          className="bg-cyan-500 hover:bg-cyan-400 text-black shrink-0 h-10 w-10 rounded-lg"
        >
          <Send className="w-4 h-4" />
        </Button>
      </div>
    </Card>
  );
}
