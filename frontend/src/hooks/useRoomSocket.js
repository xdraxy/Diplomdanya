import { useEffect, useRef, useState, useCallback } from "react";

const BACKEND_URL = process.env.REACT_APP_BACKEND_URL || "";

function buildWsUrl(code) {
  try {
    const url = new URL(BACKEND_URL);
    const wsProtocol = url.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${url.host}/api/ws/${code}`;
  } catch (err) {
    console.warn("useRoomSocket: invalid BACKEND_URL, falling back", err);
    const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    return `${wsProtocol}//${window.location.host}/api/ws/${code}`;
  }
}

export function useRoomSocket({ code, name, onMessage }) {
  const [status, setStatus] = useState("connecting");
  const wsRef = useRef(null);
  const reconnectTimer = useRef(null);
  const closedByUser = useRef(false);
  const handlerRef = useRef(onMessage);

  useEffect(() => {
    handlerRef.current = onMessage;
  }, [onMessage]);

  const connect = useCallback(() => {
    if (!code || !name) return;
    const existing = wsRef.current;
    if (
      existing &&
      (existing.readyState === WebSocket.CONNECTING ||
        existing.readyState === WebSocket.OPEN)
    ) {
      return;
    }
    closedByUser.current = false;
    setStatus("connecting");
    const ws = new WebSocket(buildWsUrl(code));
    wsRef.current = ws;

    ws.onopen = () => {
      setStatus("connected");
      ws.send(JSON.stringify({ type: "join", name }));
    };
    ws.onmessage = (evt) => {
      try {
        const msg = JSON.parse(evt.data);
        if (handlerRef.current) handlerRef.current(msg);
      } catch (err) {
        console.warn("useRoomSocket: failed to parse message", err);
      }
    };
    ws.onerror = (err) => {
      console.warn("useRoomSocket: socket error", err);
      setStatus("error");
    };
    ws.onclose = () => {
      setStatus("disconnected");
      if (!closedByUser.current) {
        reconnectTimer.current = setTimeout(connect, 2000);
      }
    };
  }, [code, name]);

  useEffect(() => {
    connect();
    return () => {
      closedByUser.current = true;
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      const ws = wsRef.current;
      if (ws) {
        try {
          ws.close();
        } catch (err) {
          console.warn("useRoomSocket: close failed", err);
        }
      }
    };
  }, [connect]);

  const send = useCallback((payload) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
      return true;
    }
    return false;
  }, []);

  return { status, send };
}
