/** Browser speech helpers for the HERMES chat (Web Speech API, no keys needed). */

const VOICE_KEY = 'endpointx_hermes_voice';

export function voicesEnabled(): boolean {
  try {
    return localStorage.getItem(VOICE_KEY) !== 'off';
  } catch {
    return true;
  }
}

export function setVoicesEnabled(on: boolean): void {
  try {
    localStorage.setItem(VOICE_KEY, on ? 'on' : 'off');
  } catch {
    // storage unavailable - preference stays in memory
  }
}

export function speechSupported(): boolean {
  return typeof window !== 'undefined' && 'speechSynthesis' in window;
}

function ptVoices(): SpeechSynthesisVoice[] {
  if (!speechSupported()) return [];
  return window.speechSynthesis.getVoices().filter((v) => v.lang.toLowerCase().startsWith('pt'));
}

export function preferredVoice(): SpeechSynthesisVoice | null {
  const list = ptVoices();
  return list.find((v) => v.lang.toLowerCase() === 'pt-pt') || list[0] || null;
}

export function stopSpeaking(): void {
  if (speechSupported()) window.speechSynthesis.cancel();
}

/** Speaks an assistant reply out loud (pt-PT when available). */
export function speak(text: string, opts?: { onEnd?: () => void }): boolean {
  if (!speechSupported()) return false;
  const clean = text
    .replace(/```[\s\S]*?```/g, ' código omitido. ')
    .replace(/[*_#`>~|-]{1,3}/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!clean) {
    opts?.onEnd?.();
    return false;
  }
  window.speechSynthesis.cancel();
  const utter = new SpeechSynthesisUtterance(clean.slice(0, 2500));
  const voice = preferredVoice();
  if (voice) utter.voice = voice;
  utter.lang = voice?.lang || 'pt-PT';
  utter.rate = 1;
  utter.pitch = 1;
  if (opts?.onEnd) {
    let fired = false;
    const done = () => {
      if (fired) return;
      fired = true;
      opts.onEnd?.();
    };
    utter.onend = done;
    utter.onerror = done;
    // Some engines never fire onend - never leave the mic stopped for good.
    window.setTimeout(done, Math.min(30000, 4000 + clean.length * 70));
  }
  window.speechSynthesis.speak(utter);
  return true;
}

export function recognitionSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const w = window as unknown as Record<string, unknown>;
  return Boolean(w.SpeechRecognition || w.webkitSpeechRecognition);
}

export interface Recognizer {
  start: () => void;
  stop: () => void;
}

interface RecognizerHandlers {
  onResult: (text: string, isFinal: boolean) => void;
  onEnd: () => void;
  onError?: (message: string) => void;
}

/** One-shot dictation in pt-PT: fills the input live and reports the final transcript. */
export function createRecognizer(handlers: RecognizerHandlers): Recognizer | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as Record<string, any>;
  const Ctor = w.SpeechRecognition || w.webkitSpeechRecognition;
  if (!Ctor) return null;
  const rec = new Ctor();
  rec.lang = 'pt-PT';
  rec.interimResults = true;
  rec.continuous = false;
  rec.onresult = (event: any) => {
    let transcript = '';
    let final = false;
    for (let i = event.resultIndex; i < event.results.length; i++) {
      transcript += event.results[i][0].transcript;
      final = event.results[i].isFinal;
    }
    handlers.onResult(transcript, final);
  };
  rec.onerror = (event: any) => handlers.onError?.(String(event?.error || 'erro de microfone'));
  rec.onend = () => handlers.onEnd();
  return {
    start: () => rec.start(),
    stop: () => {
      try {
        rec.stop();
      } catch {
        // already stopped
      }
    },
  };
}
