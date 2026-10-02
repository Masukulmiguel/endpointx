import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  MonitorPlay,
  Plug,
  PlugZap,
  Power,
  Maximize2,
  Minimize2,
  Keyboard,
  MousePointer2,
  Loader2,
} from 'lucide-react';

type Phase = 'idle' | 'connecting' | 'ready' | 'streaming' | 'offline' | 'error';

interface MonitorInfo {
  index: number;
  width: number;
  height: number;
}

const REMOTE_PATH = '/remote';

function remoteUrl(): string {
  const origin =
    window.location.hostname === 'localhost'
      ? `${window.location.protocol === 'https:' ? 'wss' : 'ws'}://${window.location.host}`
      : 'wss://endpointx.onrender.com';
  return `${origin}${REMOTE_PATH}`;
}

const BUTTONS: Record<number, 'left' | 'middle' | 'right'> = {
  0: 'left',
  1: 'middle',
  2: 'right',
};

interface Props {
  deviceId: string;
}

export default function RemoteViewer({ deviceId }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const shellRef = useRef<HTMLDivElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const busyRef = useRef(false);
  const controlRef = useRef(false);
  const lastMoveRef = useRef(0);
  const touchRef = useRef<{ x: number; y: number; t: number; moved: number; fingers: number } | null>(null);
  const manualCloseRef = useRef(false);

  const [phase, setPhase] = useState<Phase>('idle');
  const [message, setMessage] = useState('');
  const [control, setControl] = useState(false);
  const [quality, setQuality] = useState(65);
  const [fps, setFps] = useState(10);
  const [typed, setTyped] = useState('');
  const [hint, setHint] = useState(false);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [monitor, setMonitor] = useState<number | null>(null);
  const [minimized, setMinimized] = useState(false);
  const monitorRef = useRef<number | null>(null);

  useEffect(() => {
    monitorRef.current = monitor;
  }, [monitor]);

  const startMsg = (fpsOverride?: number, qualityOverride?: number) =>
    JSON.stringify({
      t: 'start',
      fps: fpsOverride ?? fps,
      quality: qualityOverride ?? quality,
      max_width: 1600,
      ...(monitorRef.current !== null ? { monitor: monitorRef.current } : {}),
    });

  useEffect(() => {
    controlRef.current = control;
  }, [control]);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
  }, []);

  const draw = useCallback(async (buffer: ArrayBuffer) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      const bitmap = await createImageBitmap(new Blob([buffer], { type: 'image/jpeg' }));
      const canvas = canvasRef.current;
      if (canvas) {
        if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
          canvas.width = bitmap.width;
          canvas.height = bitmap.height;
        }
        const ctx = canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(bitmap, 0, 0);
          setPhase('streaming');
        }
      }
      bitmap.close();
    } catch {
      // ignore malformed frame
    } finally {
      busyRef.current = false;
    }
  }, []);

  const connect = useCallback(() => {
    if (wsRef.current) return;
    manualCloseRef.current = false;
    setPhase('connecting');
    setMessage('A ligar ao servidor...');

    const token = localStorage.getItem('access_token') || '';
    const ws = new WebSocket(remoteUrl());
    ws.binaryType = 'arraybuffer';
    wsRef.current = ws;

    ws.onopen = () => {
      ws.send(JSON.stringify({ t: 'hello', role: 'operator', token, device_id: deviceId }));
    };

    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') {
        void draw(event.data as ArrayBuffer);
        return;
      }
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.t === 'ready') {
        setPhase('ready');
        setMessage(msg.agent_connected ? 'A preparar a transmissão...' : 'Agente offline neste dispositivo');
        if (msg.agent_connected) {
          ws.send(startMsg());
        }
      } else if (msg.t === 'monitors') {
        const list: MonitorInfo[] = Array.isArray(msg.monitors) ? msg.monitors : [];
        setMonitors(list);
        setMonitor((current) => {
          if (current !== null && list.some((m) => m.index === current)) return current;
          return typeof msg.primary === 'number' ? msg.primary : list[0]?.index ?? null;
        });
      } else if (msg.t === 'agent') {
        if (msg.connected) {
          setPhase('ready');
          ws.send(startMsg());
        } else {
          setPhase('offline');
          setMessage('A ligação ao agente caiu - a transmitir terminada');
        }
      } else if (msg.t === 'stopped') {
        setPhase('ready');
        setMessage('Transmissão parada');
      } else if (msg.t === 'error') {
        setPhase('error');
        setMessage(String(msg.message || 'Erro no acesso remoto'));
      } else if (msg.t === 'viewers') {
        // informational
      }
    };

    ws.onerror = () => {
      setPhase('error');
      setMessage('Não foi possível ligar ao servidor remoto');
    };

    ws.onclose = () => {
      wsRef.current = null;
      if (manualCloseRef.current) {
        setPhase('idle');
        setMessage('');
        return;
      }
      setPhase('error');
      setMessage('Ligação terminada - a tentar novamente em 3s');
      window.setTimeout(() => {
        if (!manualCloseRef.current && !wsRef.current) connect();
      }, 3000);
    };
  }, [deviceId, draw, fps, quality]);

  const disconnect = useCallback(() => {
    manualCloseRef.current = true;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.send(JSON.stringify({ t: 'stop' }));
        ws.close();
      } catch {
        // ignore
      }
    }
    setPhase('idle');
    setMessage('');
  }, []);

  useEffect(() => () => {
    manualCloseRef.current = true;
    const ws = wsRef.current;
    wsRef.current = null;
    if (ws) {
      try {
        ws.close();
      } catch {
        // ignore
      }
    }
  }, []);

  const setStreamParams = (nextFps: number, nextQuality: number) => {
    setFps(nextFps);
    setQuality(nextQuality);
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(startMsg(nextFps, nextQuality));
    }
  };

  // ---- pointer ---------------------------------------------------------

  const norm = (clientX: number, clientY: number) => {
    const rect = canvasRef.current?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)),
      y: Math.min(1, Math.max(0, (clientY - rect.top) / rect.height)),
    };
  };

  const onMouseMove = (e: React.MouseEvent) => {
    if (!controlRef.current) return;
    const now = Date.now();
    if (now - lastMoveRef.current < 30) return;
    lastMoveRef.current = now;
    const p = norm(e.clientX, e.clientY);
    if (p) send({ t: 'mouse', action: 'move', x: p.x, y: p.y });
  };

  const onMouseDown = (e: React.MouseEvent) => {
    if (!controlRef.current) return;
    const p = norm(e.clientX, e.clientY);
    if (p) send({ t: 'mouse', action: 'down', x: p.x, y: p.y, button: BUTTONS[e.button] || 'left' });
  };

  const onMouseUp = (e: React.MouseEvent) => {
    if (!controlRef.current) return;
    const p = norm(e.clientX, e.clientY);
    if (p) send({ t: 'mouse', action: 'up', x: p.x, y: p.y, button: BUTTONS[e.button] || 'left' });
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!controlRef.current) return;
    send({ t: 'wheel', dx: Math.round(e.deltaX / 100), dy: -Math.round(e.deltaY / 100) });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!controlRef.current) return;
    e.preventDefault();
    send({ t: 'key', code: e.code, action: 'down' });
  };

  const onKeyUp = (e: React.KeyboardEvent) => {
    if (!controlRef.current) return;
    e.preventDefault();
    send({ t: 'key', code: e.code, action: 'up' });
  };

  // ---- touch (phone / tablet as the operator side) ---------------------

  const onTouchStart = (e: React.TouchEvent) => {
    if (!controlRef.current) return;
    const t = e.touches[0];
    touchRef.current = {
      x: t.clientX,
      y: t.clientY,
      t: Date.now(),
      moved: 0,
      fingers: e.touches.length,
    };
  };

  const onTouchMove = (e: React.TouchEvent) => {
    if (!controlRef.current || !touchRef.current) return;
    const touch = touchRef.current;
    if (e.touches.length > 1) {
      const t = e.touches[0];
      const dy = touch.y - t.clientY;
      touch.y = t.clientY;
      touch.x = t.clientX;
      touch.moved += 100;
      if (Math.abs(dy) > 4) send({ t: 'wheel', dy: Math.round(dy / 12) });
      return;
    }
    const t = e.touches[0];
    touch.moved += Math.abs(t.clientX - touch.x) + Math.abs(t.clientY - touch.y);
    const p = norm(t.clientX, t.clientY);
    if (p) send({ t: 'mouse', action: 'move', x: p.x, y: p.y });
    touch.x = t.clientX;
    touch.y = t.clientY;
  };

  const onTouchEnd = (e: React.TouchEvent) => {
    if (!controlRef.current || !touchRef.current) return;
    const touch = touchRef.current;
    touchRef.current = null;
    if (e.touches.length > 0) return;
    if (Date.now() - touch.t < 300 && touch.moved < 12) {
      const p = norm(touch.x, touch.y);
      if (p) send({ t: 'mouse', action: 'click', x: p.x, y: p.y, button: 'left' });
    }
  };

  const sendTyped = () => {
    if (!typed) return;
    send({ t: 'type', text: typed });
    setTyped('');
  };

  const toggleFullscreen = () => {
    const el = shellRef.current;
    if (!el) return;
    if (document.fullscreenElement) document.exitFullscreen();
    else el.requestFullscreen?.();
  };

  const busy = phase === 'connecting';
  const statusLabel: Record<Phase, string> = {
    idle: 'Desligado',
    connecting: 'A ligar...',
    ready: 'Ligado - à espera de vídeo',
    streaming: 'Transmitindo',
    offline: 'Agente offline',
    error: 'Erro',
  };

  const selectMonitor = (value: number) => {
    setMonitor(value);
    monitorRef.current = value;
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ t: 'start', fps, quality, max_width: 1600, monitor: value }));
    }
  };

  if (minimized) {
    // Single collapsed strip: the session keeps running so it can be reopened
    // instantly without renegotiating with the agent.
    return (
      <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 px-4 py-3 flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 min-w-0">
          <MonitorPlay className="w-5 h-5 text-blue-600 dark:text-blue-400 flex-shrink-0" />
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white truncate">Acesso remoto</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400 truncate">{statusLabel[phase]}</p>
          </div>
          <span
            className={`inline-block w-2 h-2 rounded-full flex-shrink-0 ${
              phase === 'streaming' ? 'bg-green-500' : phase === 'connecting' ? 'bg-yellow-500 animate-pulse' : 'bg-gray-400'
            }`}
            title={statusLabel[phase]}
          />
        </div>
        <div className="flex items-center gap-2 flex-shrink-0">
          <button
            onClick={() => setMinimized(false)}
            className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700"
          >
            <Maximize2 className="w-3.5 h-3.5" />
            Abrir
          </button>
          {phase !== 'idle' && phase !== 'error' && (
            <button
              onClick={disconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700"
            >
              <Power className="w-3.5 h-3.5" />
              Desligar
            </button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="bg-white dark:bg-gray-800 rounded-xl border border-gray-200 dark:border-gray-700 p-4 sm:p-6">
      <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <MonitorPlay className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          <div>
            <h3 className="text-sm font-semibold text-gray-900 dark:text-white">Acesso remoto</h3>
            <p className="text-xs text-gray-500 dark:text-gray-400">{statusLabel[phase]}</p>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          <select
            value={fps}
            onChange={(e) => setStreamParams(Number(e.target.value), quality)}
            className="text-xs px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          >
            <option value={5}>5 fps</option>
            <option value={10}>10 fps</option>
            <option value={15}>15 fps</option>
            <option value={24}>24 fps</option>
          </select>
          <select
            value={quality}
            onChange={(e) => setStreamParams(fps, Number(e.target.value))}
            className="text-xs px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
          >
            <option value={40}>Qualidade baixa</option>
            <option value={65}>Qualidade média</option>
            <option value={85}>Qualidade alta</option>
          </select>
          <button
            onClick={() => setControl((c) => !c)}
            disabled={phase === 'idle' || phase === 'offline'}
            className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg transition-colors disabled:opacity-50 ${
              control
                ? 'bg-green-600 text-white hover:bg-green-700'
                : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600'
            }`}
            title="Ativar controlo de rato e teclado"
          >
            <MousePointer2 className="w-3.5 h-3.5" />
            {control ? 'Controlo ativo' : 'Só visualizar'}
          </button>
          {monitors.length > 1 && (
            <select
              value={monitor ?? ''}
              onChange={(e) => selectMonitor(Number(e.target.value))}
              className="text-xs px-2 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300"
              title="Ecrã a transmitir"
            >
              {monitors.map((m) => (
                <option key={m.index} value={m.index}>
                  Ecrã {m.index} ({m.width}x{m.height})
                </option>
              ))}
            </select>
          )}
          <button
            onClick={toggleFullscreen}
            className="p-1.5 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            title="Ecrã inteiro"
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
          <button
            onClick={() => setMinimized(true)}
            className="p-1.5 text-xs rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
            title="Minimizar (a sessão continua ativa)"
          >
            <Minimize2 className="w-3.5 h-3.5" />
          </button>
          {phase === 'idle' || phase === 'error' ? (
            <button
              onClick={connect}
              disabled={busy}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <PlugZap className="w-3.5 h-3.5" />}
              Ligar
            </button>
          ) : (
            <button
              onClick={disconnect}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-red-600 text-white hover:bg-red-700 transition-colors"
            >
              <Power className="w-3.5 h-3.5" />
              Desligar
            </button>
          )}
        </div>
      </div>

      <div
        ref={shellRef}
        tabIndex={0}
        onKeyDown={onKeyDown}
        onKeyUp={onKeyUp}
        onMouseMove={onMouseMove}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onContextMenu={(e) => controlRef.current && e.preventDefault()}
        onWheel={onWheel}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        className={`relative rounded-xl overflow-hidden bg-black outline-none ${
          control ? 'cursor-crosshair' : 'cursor-default'
        }`}
        style={{ touchAction: control ? 'none' : 'auto' }}
      >
        <canvas ref={canvasRef} className="block w-full h-auto" />

        {phase !== 'streaming' && (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-4">
            {phase === 'connecting' ? (
              <Loader2 className="w-6 h-6 animate-spin text-white/80" />
            ) : (
              <Plug className="w-6 h-6 text-white/60" />
            )}
            <p className="text-sm text-white/80">{message || 'Pressione Ligar para iniciar a assistência remota'}</p>
            <p className="text-xs text-white/50">
              O agente instala-se uma vez e fica sempre acessível, sem abrir portas no firewall.
            </p>
          </div>
        )}

        {control && phase === 'streaming' && (
          <div className="absolute top-2 left-2 px-2 py-1 rounded bg-black/60 text-[11px] text-green-300">
            controlo ativo
          </div>
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          onClick={() => setHint((h) => !h)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600"
        >
          <Keyboard className="w-3.5 h-3.5" />
          Teclas rápidas
        </button>
        <div className="flex items-center gap-2 flex-1 min-w-[220px]">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                sendTyped();
              }
            }}
            disabled={!control || phase !== 'streaming'}
            placeholder="Escrever texto no equipamento remoto..."
            className="flex-1 text-xs px-3 py-1.5 rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-900 text-gray-700 dark:text-gray-300 placeholder:text-gray-400 disabled:opacity-50"
          />
          <button
            onClick={sendTyped}
            disabled={!control || phase !== 'streaming' || !typed}
            className="px-3 py-1.5 text-xs font-medium rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
          >
            Enviar
          </button>
        </div>
      </div>

      {hint && (
        <div className="mt-3 text-xs text-gray-600 dark:text-gray-400 space-y-1">
          <p>• Ative <strong>Controlo</strong> e clique no ecrã para controlar o rato do equipamento remoto.</p>
          <p>• Tab para focar a área de vídeo e usar o teclado; atalhos (Ctrl+C, Ctrl+R, Win+D) funcionam normalmente.</p>
          <p>• No telemóvel: arrastar move o rato, toque curto clica, dois dedos faz scroll.</p>
          <p>• Tudo trafega cifrado (WSS/TLS) pelo servidor EndpointX - o equipamento não abre portas.</p>
          <p>
            • O ecrã repete-se dentro de si mesmo (eco)? Estás a ver o <strong>mesmo PC</strong> onde está
            aberto este dashboard — minimize a janela do browser no equipamento alvo ou escolhe outro ecrã.
          </p>
        </div>
      )}
    </div>
  );
}
