// Modulo condiviso dalle tre pagine.
// L'unica riga da cambiare al deploy è questa:
// const API = "https://eliminacode.deno.dev";
const API = "http://localhost:8000";

// --- client HTTP -------------------------------------------------------
// I POST partono come text/plain di proposito: così restano richieste
// "semplici" e il browser non aggiunge un preflight OPTIONS a ogni azione.

async function chiama(percorso, corpo) {
  const opzioni = corpo === undefined
    ? { method: "GET" }
    : {
      method: "POST",
      headers: { "content-type": "text/plain;charset=UTF-8" },
      body: JSON.stringify(corpo),
    };
  const r = await fetch(API + percorso, opzioni);
  const testo = await r.text();
  let dati = {};
  try { dati = testo ? JSON.parse(testo) : {}; } catch { /* non JSON */ }
  if (!r.ok) {
    const e = new Error(dati.errore || `errore ${r.status}`);
    e.stato = r.status;
    throw e;
  }
  return dati;
}

export const api = {
  crea: (nome) => chiama("/api/queues", { nome }),
  stato: (c) => chiama(`/api/q/${c}`),
  ticket: (c) => chiama(`/api/q/${c}/ticket`, {}),
  next: (c, token) => chiama(`/api/q/${c}/next`, { token }),
  recall: (c, token) => chiama(`/api/q/${c}/recall`, { token }),
  set: (c, token, campi) => chiama(`/api/q/${c}/set`, { token, ...campi }),
};

// --- orologio ----------------------------------------------------------
// L'orologio del telefono può essere sfasato di minuti. Ogni risposta porta
// il tempo del server: teniamo lo scarto e calcoliamo sempre su quello,
// altrimenti il conto alla rovescia parte da un valore negativo.

let scarto = 0;
export const allineaOrologio = (now) => { if (now) scarto = now - Date.now(); };
export const adesso = () => Date.now() + scarto;

// --- memoria locale ----------------------------------------------------

export function ricorda(chiave, valore) {
  try { localStorage.setItem(chiave, JSON.stringify(valore)); } catch { /* modalità privata */ }
}

export function ricordato(chiave) {
  try {
    const v = localStorage.getItem(chiave);
    return v === null ? null : JSON.parse(v);
  } catch { return null; }
}

export function dimentica(chiave) {
  try { localStorage.removeItem(chiave); } catch { /* modalità privata */ }
}

// --- formattazione -----------------------------------------------------

/** Stime prudenti: sotto il minuto non si danno secondi, sopra i dieci
 *  minuti si arrotonda a cinque. "circa 25 minuti" invita ad aspettare,
 *  "24:37" invita a contestare. */
export function formattaAttesa(ms) {
  if (ms <= 0) return "a momenti";
  const min = ms / 60000;
  if (min < 1) return "meno di un minuto";
  if (min < 2) return "circa un minuto";
  if (min < 10) return `circa ${Math.round(min)} minuti`;
  if (min < 90) return `circa ${Math.round(min / 5) * 5} minuti`;
  return "più di un'ora e mezza";
}

export function plurale(n, uno, molti) {
  return `${n} ${n === 1 ? uno : molti}`;
}

// --- polling adattivo --------------------------------------------------
// Fitto quando manca poco, rado quando il turno è lontano, e con backoff
// se la rete cade. Un poll immediato al ritorno in primo piano: è il
// momento in cui l'utente vuole vedere la verità, non un dato vecchio.

export function avviaPolling({ leggi, aggiorna, suErrore, intervallo }) {
  let timer = null;
  let fallimenti = 0;
  let vivo = true;

  function riprogramma() {
    if (!vivo) return;
    const attesa = fallimenti > 0
      ? Math.min(2000 * 2 ** (fallimenti - 1), 30000)
      : intervallo();
    timer = setTimeout(giro, attesa);
  }

  async function giro() {
    if (!vivo) return;

    let s;
    try {
      s = await leggi();
    } catch (e) {
      fallimenti++;
      suErrore(e, fallimenti);
      riprogramma();
      return;
    }

    allineaOrologio(s.now);
    fallimenti = 0;

    // Il disegno ha il suo try separato di proposito. Se stesse insieme alla
    // lettura, un errore nel rendering verrebbe contato come una rete caduta:
    // la pagina direbbe "connessione persa" mentre il vero problema è nel
    // codice, e il backoff arriverebbe a 30 secondi nascondendolo del tutto.
    try {
      aggiorna(s);
    } catch (e) {
      console.error("[eliminacode] errore nel disegno della pagina:", e, s);
    }

    riprogramma();
  }

  function subito() {
    clearTimeout(timer);
    giro();
  }

  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") subito();
  });
  globalThis.addEventListener("online", subito);

  giro();
  return { subito, ferma: () => { vivo = false; clearTimeout(timer); } };
}

// --- avvisi ------------------------------------------------------------
// Su iOS l'audio delle pagine web va sbloccato da un gesto dell'utente e
// l'interruttore silenzioso lo zittisce comunque; navigator.vibrate non
// esiste su Safari. Per questo l'avviso visivo non è un contorno: su un
// iPhone silenzioso è l'unico canale che resta.

let audio = null;
let wakeLock = null;

export async function attivaAvvisi() {
  try {
    audio = new (globalThis.AudioContext || globalThis.webkitAudioContext)();
    await audio.resume();
    beep(audio.currentTime, 0.08, 660, 0.12); // conferma udibile
  } catch { audio = null; }

  try {
    if ("Notification" in globalThis && Notification.permission === "default") {
      await Notification.requestPermission();
    }
  } catch { /* permesso negato */ }

  await tieniAccesoLoSchermo();
  return { audio: !!audio };
}

function beep(quando, durata, frequenza, volume) {
  const osc = audio.createOscillator();
  const gain = audio.createGain();
  osc.type = "square";
  osc.frequency.value = frequenza;
  gain.gain.setValueAtTime(0, quando);
  gain.gain.linearRampToValueAtTime(volume, quando + 0.01);
  gain.gain.setValueAtTime(volume, quando + durata - 0.02);
  gain.gain.linearRampToValueAtTime(0, quando + durata);
  osc.connect(gain).connect(audio.destination);
  osc.start(quando);
  osc.stop(quando + durata + 0.02);
}

/** `forte` è l'avviso di turno, l'altro è il preavviso. */
export function suona(forte) {
  if (audio && audio.state === "suspended") audio.resume().catch(() => {});
  if (audio && audio.state === "running") {
    const t = audio.currentTime + 0.02;
    const schema = forte
      ? [0, .18, .36, .9, 1.08, 1.26, 1.8, 1.98, 2.16]
      : [0, .3];
    for (const d of schema) beep(t + d, forte ? 0.14 : 0.1, forte ? 880 : 520, forte ? 0.3 : 0.12);
  }
  try {
    navigator.vibrate?.(forte ? [400, 150, 400, 150, 600] : [200]);
  } catch { /* non supportato */ }
}

export function notifica(titolo, testo) {
  try {
    if ("Notification" in globalThis && Notification.permission === "granted" &&
      document.visibilityState !== "visible") {
      new Notification(titolo, { body: testo, tag: "eliminacode", renotify: true });
    }
  } catch { /* non supportato */ }
}

export async function tieniAccesoLoSchermo() {
  try {
    if ("wakeLock" in navigator && !wakeLock) {
      wakeLock = await navigator.wakeLock.request("screen");
      wakeLock.addEventListener("release", () => { wakeLock = null; });
    }
  } catch { wakeLock = null; }
}

export function rilasciaSchermo() {
  try { wakeLock?.release(); } catch { /* già rilasciato */ }
  wakeLock = null;
}

document.addEventListener("visibilitychange", () => {
  // Il wake lock viene revocato quando la scheda passa in background.
  if (document.visibilityState === "visible" && wakeLock === null) {
    tieniAccesoLoSchermo();
  }
});

// --- varie -------------------------------------------------------------

export function parametro(nome) {
  return new URLSearchParams(location.search).get(nome) || "";
}

export function urlCoda(codice) {
  return new URL(`q.html?c=${codice}`, location.href).href;
}

export function disegnaQr(contenitore, testo) {
  // qrcode-generator (MIT, Kazuhiko Arase), copia locale in vendor/.
  // Tipo 0 = versione scelta automaticamente, correzione M.
  const qr = globalThis.qrcode(0, "M");
  qr.addData(testo);
  qr.make();
  contenitore.innerHTML = qr.createImgTag(8, 16, "QR code della coda");
}
