import {
  aggiorna,
  type Coda,
  Conflitto,
  crea,
  emetti,
  leggi,
  pulisci,
  type Vista,
} from "./store.ts";

// ---------------------------------------------------------------- config

// Origini ammesse, separate da virgola. Es:
// ORIGINI=https://petrus-giannini.github.io
// Se non impostata si accetta qualunque origine: comodo in locale,
// da impostare sempre in produzione.
const ORIGINI = (Deno.env.get("ORIGINI") ?? "")
  .split(",").map((s) => s.trim()).filter(Boolean);

const MAX_NOME = 40;
const TICKET_PER_IP = 6; // in una finestra di 10 minuti, best effort
const FINESTRA_MS = 10 * 60 * 1000;
const PAUSA_MAX_MS = 15 * 60 * 1000; // oltre questo il campione è una pausa
const RIMBALZO_MS = 3000; // sotto questo è un doppio click
const ALFA = 0.3;

// Alfabeto senza caratteri confondibili: niente 0/O, niente 1/I/L.
const ALFABETO = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";

// ---------------------------------------------------------------- utilità

/** 31 simboli: scarto i byte >= 248 per non introdurre bias di modulo. */
function stringaCasuale(lunghezza: number): string {
  let s = "";
  while (s.length < lunghezza) {
    const buf = new Uint8Array(lunghezza * 2);
    crypto.getRandomValues(buf);
    for (const b of buf) {
      if (b >= 248) continue;
      s += ALFABETO[b % 31];
      if (s.length === lunghezza) break;
    }
  }
  return s;
}

async function sha256(s: string): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function confrontoCostante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const contatori = new Map<string, { n: number; reset: number }>();

/** Limite per IP sulle sole prenotazioni. Vive in memoria dell'isolate,
 *  quindi è una barriera contro la distrazione, non contro un attacco. */
function limiteSuperato(ip: string): boolean {
  const ora = Date.now();
  const c = contatori.get(ip);
  if (!c || ora > c.reset) {
    if (contatori.size > 5000) contatori.clear();
    contatori.set(ip, { n: 1, reset: ora + FINESTRA_MS });
    return false;
  }
  c.n++;
  return c.n > TICKET_PER_IP;
}

function intestazioniCors(origine: string | null): Record<string, string> {
  const ammessa = ORIGINI.length === 0 || (!!origine && ORIGINI.includes(origine));
  return {
    "access-control-allow-origin": ammessa ? (origine ?? "*") : "null",
    "access-control-allow-methods": "GET, POST, OPTIONS",
    "access-control-allow-headers": "content-type",
    "access-control-max-age": "86400",
    "vary": "origin",
  };
}

function json(dati: unknown, stato: number, origine: string | null): Response {
  return new Response(JSON.stringify(dati), {
    status: stato,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...intestazioniCors(origine),
    },
  });
}

const errore = (msg: string, stato: number, origine: string | null) =>
  json({ errore: msg }, stato, origine);

/** Il corpo arriva come text/plain: così la POST resta una richiesta
 *  "semplice" e il browser non fa scattare il preflight CORS. */
async function corpo(req: Request): Promise<Record<string, unknown>> {
  const t = await req.text();
  if (!t) return {};
  try {
    const v = JSON.parse(t);
    return (v && typeof v === "object" && !Array.isArray(v)) ? v : {};
  } catch {
    return {};
  }
}

/** Vista pubblica: ~130 byte, nessun segreto. È il payload del polling. */
function statoPubblico(v: Vista) {
  const c = v.coda;
  return {
    nome: c.nome,
    cur: c.inServizio,
    last: v.emessi,
    open: c.aperta,
    ct: c.chiamatoIl,
    avg: c.mediaServizioMs,
    srv: c.serviti,
    rs: c.richiamiSeq,
    ver: c.ver,
    now: Date.now(), // per l'offset di orologio lato client
  };
}

/**
 * Media mobile esponenziale sull'intervallo fra due chiamate.
 * Scarta le pause (oltre 15 minuti, o oltre 4 volte la media corrente una
 * volta che la media è affidabile) e i rimbalzi sotto i 3 secondi.
 */
export function nuovaMedia(c: Coda, ora: number): { media: number; contato: boolean } {
  if (c.chiamatoIl === 0) return { media: c.mediaServizioMs, contato: false };
  const d = ora - c.chiamatoIl;
  const tetto = c.serviti >= 3
    ? Math.min(PAUSA_MAX_MS, c.mediaServizioMs * 4)
    : PAUSA_MAX_MS;
  if (d < RIMBALZO_MS || d > tetto) return { media: c.mediaServizioMs, contato: false };
  const media = c.mediaServizioMs === 0
    ? d
    : Math.round(ALFA * d + (1 - ALFA) * c.mediaServizioMs);
  return { media, contato: true };
}

async function autorizzato(c: Coda, token: unknown): Promise<boolean> {
  if (typeof token !== "string" || token.length < 20) return false;
  return confrontoCostante(await sha256(token), c.adminHash);
}

// ---------------------------------------------------------------- handler

export async function gestisci(req: Request): Promise<Response> {
  const origine = req.headers.get("origin");
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: intestazioniCors(origine) });
  }

  const parti = new URL(req.url).pathname.split("/").filter(Boolean);
  if (parti[0] !== "api") return errore("non trovato", 404, origine);

  try {
    // POST /api/queues --------------------------------------------------
    if (parti[1] === "queues" && parti.length === 2 && req.method === "POST") {
      const b = await corpo(req);
      const nome = String(b.nome ?? "").trim().replace(/\s+/g, " ").slice(0, MAX_NOME);
      if (nome.length < 2) return errore("il nome deve avere almeno 2 caratteri", 400, origine);

      const token = stringaCasuale(26); // ~128 bit
      const adminHash = await sha256(token);

      for (let i = 0; i < 5; i++) {
        const codice = stringaCasuale(8); // ~40 bit
        const coda: Coda = {
          nome,
          adminHash,
          inServizio: 0,
          chiamatoIl: 0,
          richiamiSeq: 0,
          mediaServizioMs: 0,
          serviti: 0,
          aperta: true,
          creataIl: Date.now(),
          ver: 1,
        };
        if (await crea(codice, coda)) return json({ codice, token, nome }, 201, origine);
      }
      return errore("codice non disponibile, riprova", 503, origine);
    }

    // /api/q/:codice[/azione] -------------------------------------------
    if (parti[1] !== "q" || parti.length < 3 || parti.length > 4) {
      return errore("non trovato", 404, origine);
    }

    const codice = parti[2].toUpperCase();
    const azione = parti[3];

    if (!azione) {
      if (req.method !== "GET") return errore("metodo non ammesso", 405, origine);
      const v = await leggi(codice);
      if (!v) return errore("coda non trovata o scaduta", 404, origine);
      return json(statoPubblico(v), 200, origine);
    }

    if (req.method !== "POST") return errore("metodo non ammesso", 405, origine);
    const b = await corpo(req);

    // POST /api/q/:codice/ticket — pubblico ------------------------------
    if (azione === "ticket") {
      const ip = (req.headers.get("x-forwarded-for") ?? "?").split(",")[0].trim();
      if (limiteSuperato(ip)) {
        return errore("troppe prenotazioni, attendi qualche minuto", 429, origine);
      }
      const n = await emetti(codice);
      if (n === null) return errore("coda non trovata o scaduta", 404, origine);
      if (n === -1) return errore("le prenotazioni sono chiuse", 403, origine);
      const v = await leggi(codice);
      return json({ n, ...statoPubblico(v!) }, 201, origine);
    }

    // Da qui in poi serve il token del master ----------------------------
    const attuale = await leggi(codice);
    if (!attuale) return errore("coda non trovata o scaduta", 404, origine);
    if (!await autorizzato(attuale.coda, b.token)) {
      return errore("non autorizzato", 403, origine);
    }

    if (azione === "next") {
      let vuota = false;
      const v = await aggiorna(codice, ({ coda, emessi }) => {
        if (coda.inServizio >= emessi) {
          vuota = true;
          return null;
        }
        const ora = Date.now();
        const { media, contato } = nuovaMedia(coda, ora);
        coda.mediaServizioMs = media;
        if (contato) coda.serviti += 1;
        coda.inServizio += 1;
        coda.chiamatoIl = ora;
        return coda;
      });
      if (!v) return errore("coda non trovata o scaduta", 404, origine);
      if (vuota) return errore("nessuno in attesa", 409, origine);
      return json(statoPubblico(v), 200, origine);
    }

    if (azione === "recall") {
      const v = await aggiorna(codice, ({ coda }) => {
        if (coda.inServizio === 0) return null;
        coda.richiamiSeq += 1;
        return coda;
      });
      if (!v) return errore("coda non trovata o scaduta", 404, origine);
      return json(statoPubblico(v), 200, origine);
    }

    // { inServizio?: number, aperta?: boolean }
    if (azione === "set") {
      const v = await aggiorna(codice, ({ coda, emessi }) => {
        if (typeof b.aperta === "boolean") coda.aperta = b.aperta;
        if (Number.isInteger(b.inServizio)) {
          const n = Math.max(0, Math.min(Number(b.inServizio), emessi));
          if (n !== coda.inServizio) {
            // Correzione manuale: è una nuova chiamata, ma la media non si tocca
            // perché il salto non misura un tempo di servizio.
            coda.inServizio = n;
            coda.chiamatoIl = Date.now();
          }
        }
        return coda;
      });
      if (!v) return errore("coda non trovata o scaduta", 404, origine);
      return json(statoPubblico(v), 200, origine);
    }

    return errore("non trovato", 404, origine);
  } catch (e) {
    if (e instanceof Conflitto) return errore("coda occupata, riprova", 503, origine);
    console.error(e);
    return errore("errore interno", 500, origine);
  }
}

if (import.meta.main) {
  // Raccoglie i contatori orfani. Se Deno.cron non è disponibile si può
  // togliere: la memoria che recupera è trascurabile.
  try {
    Deno.cron("pulizia contatori", "17 4 * * *", async () => {
      console.log("contatori orfani rimossi:", await pulisci());
    });
  } catch { /* cron non disponibile in questo ambiente */ }

  Deno.serve(gestisci);
}
