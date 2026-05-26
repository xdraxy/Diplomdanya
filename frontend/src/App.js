import "@/App.css";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "@/components/ui/sonner";
import Login from "@/pages/Login";
import Room from "@/pages/Room";

const TOAST_OPTIONS = {
  style: {
    background: "rgba(24, 24, 27, 0.95)",
    border: "1px solid rgba(255,255,255,0.08)",
    color: "#fafafa",
    backdropFilter: "blur(12px)",
  },
};

function App() {
  return (
    <div className="App min-h-screen bg-zinc-950 text-zinc-100">
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Login />} />
          <Route path="/room/:code" element={<Room />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
      <Toaster theme="dark" position="top-right" toastOptions={TOAST_OPTIONS} />
    </div>
  );
}

export default App;
