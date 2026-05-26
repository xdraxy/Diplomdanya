import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";

function initials(name) {
  if (!name) return "?";
  const parts = name.trim().split(/\s+/);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

export default function ParticipantsList({ participants, myName, lastUploader }) {
  return (
    <Card className="bg-zinc-900/50 border-zinc-800 rounded-xl p-4 h-full overflow-hidden flex flex-col">
      <ScrollArea className="flex-1" data-testid="participants-scroll">
        <ul className="flex flex-col gap-2">
          {participants.length === 0 ? (
            <li className="text-center text-sm text-zinc-600 py-8">
              Никого нет
            </li>
          ) : (
            participants.map((p, idx) => (
              <li
                key={`${p}-${idx}`}
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
                    {p === myName && (
                      <span className="text-zinc-500 ml-1.5 text-xs">
                        (вы)
                      </span>
                    )}
                  </div>
                  {lastUploader === p && (
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
  );
}
