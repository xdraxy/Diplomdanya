import { useMemo } from "react";
import { QRCodeSVG } from "qrcode.react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Copy, Link as LinkIcon } from "lucide-react";
import { toast } from "sonner";

export default function ShareDialog({ open, onOpenChange, code }) {
  const url = useMemo(() => {
    if (typeof window === "undefined") return "";
    return `${window.location.origin}/room/${code}`;
  }, [code]);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      toast.success("Ссылка скопирована");
    } catch {
      toast.error("Не удалось скопировать");
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

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="bg-zinc-900 border-zinc-800 text-zinc-100 max-w-md"
        data-testid="share-dialog"
      >
        <DialogHeader>
          <DialogTitle className="text-white">
            Пригласить в комнату
          </DialogTitle>
          <DialogDescription className="text-zinc-400">
            Покажите QR-код или поделитесь ссылкой — друзья сразу попадут
            прямо в комнату.
          </DialogDescription>
        </DialogHeader>

        <div className="flex justify-center py-4">
          <div className="p-4 rounded-2xl bg-white shadow-lg" data-testid="share-qr">
            <QRCodeSVG
              value={url}
              size={200}
              level="M"
              bgColor="#ffffff"
              fgColor="#09090b"
            />
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">
              Код комнаты
            </div>
            <button
              onClick={copyCode}
              className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 hover:border-cyan-500/50 transition-colors"
              data-testid="share-copy-code"
            >
              <span className="mono text-xl font-black tracking-[0.3em] text-white">
                {code}
              </span>
              <Copy className="w-4 h-4 text-zinc-500" />
            </button>
          </div>

          <div>
            <div className="text-[10px] uppercase tracking-[0.2em] text-zinc-500 mb-1">
              Прямая ссылка
            </div>
            <button
              onClick={copyUrl}
              className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-zinc-950 border border-zinc-800 hover:border-cyan-500/50 transition-colors"
              data-testid="share-copy-url"
            >
              <span className="text-sm text-zinc-300 truncate flex items-center gap-2 min-w-0">
                <LinkIcon className="w-3.5 h-3.5 text-zinc-500 shrink-0" />
                <span className="truncate">{url}</span>
              </span>
              <Copy className="w-4 h-4 text-zinc-500 shrink-0" />
            </button>
          </div>
        </div>

        <div className="flex justify-end pt-2">
          <Button
            variant="ghost"
            onClick={() => onOpenChange(false)}
            data-testid="share-close-button"
          >
            Закрыть
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
