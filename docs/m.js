import {
  api,
  avviaPolling,
  cifre,
  colore,
  disegnaQr,
  formattaAttesa,
  parametro,
  ricorda,
  ricordato,
  urlCoda,
} from "./comune.js";

const $ = (id) => document.getElementById(id);
const codice = parametro("c").toUpperCase();

// Il token arriva nel frammento dell'URL: il frammento non viene mai inviato
// al server, quindi non finisce nei log né nell'header Referer. Lo spostiamo
// subito in localStorage e lo togliamo dalla barra degli indirizzi.
const token = location.hash.slice(1) || ricordato(`ec:master:${codice}`) || "";
if (location.hash) {
  ricorda(`ec:master:${codice}`, token);
  history.replaceState(null, "", `m.html?c=${codice}`);
}

if (!codice || !token) location.replace("index.html");

const link = urlCoda(codice);
let ultimo = null;
let polling = null;

// Riferimento tenuto da parte: dopo remove() l'elemento esce dal documento e
// getElementById restituisce null, quindi $("caricamento") al secondo giro
// sarebbe nullo. Sulla referenza isConnected continua a funzionare.
const caricamento = $("caricamento");
const togliCaricamento = () => { if (caricamento.isConnected) caricamento.remove(); };

// --- disegno -----------------------------------------------------------
// mostra() è l'unica funzione che decide cosa è abilitato: così non esiste
// uno stato intermedio in cui un bottone resta spento per sbaglio.

function mostra(s) {
  ultimo = s;
  $("insegna").textContent = s.nome;
  document.title = `${s.cur ? cifre(s.cur) : "—"} · ${s.nome}`;
  $("corrente").textContent = s.cur ? cifre(s.cur) : "—";
  // Stessa sagoma e stesso colore del biglietto di chi aspetta: il colore è
  // la cifra alta, e senza il 23 e il 123 sarebbero indistinguibili in sala.
  $("biglietto").dataset.colore = colore(s.cur);
  $("attesa").textContent = Math.max(0, s.last - s.cur);
  $("emessi").textContent = s.last;
  $("media").textContent = s.srv >= 3
    ? formattaAttesa(s.avg).replace("circa ", "")
    : "—";

  const vuota = s.cur >= s.last;
  $("prossimo").disabled = vuota;
  $("prossimo").textContent = vuota
    ? "Nessuno in attesa"
    : `Chiama il ${cifre(s.cur + 1)}`;
  $("richiama").disabled = s.cur === 0;
  $("indietro").disabled = s.cur === 0;
  $("chiudi").disabled = false;
  $("chiudi").textContent = s.open ? "Chiudi le prenotazioni" : "Riapri le prenotazioni";
  // Sta sotto il QR, in uno spazio stretto: due righe al massimo.
  $("didascalia").textContent = s.open
    ? "Inquadra per metterti in coda"
    : "Prenotazioni chiuse";
}

function scomparsa() {
  polling?.ferma();
  togliCaricamento();
  $("pannello").classList.add("nascosto");
  $("assente").classList.remove("nascosto");
}

function segnalaErrore(testo) {
  const e = $("errore");
  e.textContent = testo;
  e.classList.remove("nascosto");
  clearTimeout(segnalaErrore.t);
  segnalaErrore.t = setTimeout(() => e.classList.add("nascosto"), 5000);
}

// --- comandi -----------------------------------------------------------
// Ogni comando ridisegna con la risposta del server, mai con uno stato
// ottimistico: il numero chiamato è la sola cosa che non deve mai mentire.

async function comando(bottone, azione) {
  bottone.disabled = true;
  try {
    mostra(await azione());
  } catch (e) {
    if (e.stato === 404) return scomparsa();
    if (e.stato === 403) segnalaErrore("Questo link non è più valido per la coda.");
    else if (e.stato === 409) segnalaErrore("Non c'è nessuno in attesa.");
    else segnalaErrore(`Comando non riuscito: ${e.message}`);
    if (ultimo) mostra(ultimo);
    else bottone.disabled = false;
  }
}

$("prossimo").addEventListener("click", (e) =>
  comando(e.currentTarget, () => api.next(codice, token)));

$("richiama").addEventListener("click", (e) =>
  comando(e.currentTarget, () => api.recall(codice, token)));

$("indietro").addEventListener("click", (e) =>
  comando(e.currentTarget, () =>
    api.set(codice, token, { inServizio: Math.max(0, (ultimo?.cur ?? 1) - 1) })));

$("chiudi").addEventListener("click", (e) =>
  comando(e.currentTarget, () => api.set(codice, token, { aperta: !ultimo?.open })));

// --- QR e link ---------------------------------------------------------

disegnaQr($("qr"), link);

const linkRiservato = `${location.origin}${location.pathname}?c=${codice}#${token}`;
$("linkMaster").textContent = linkRiservato;

// Il link riservato contiene il token e resta coperto finché non lo si chiede.
// Questa pagina è pensata per stare girata verso i clienti: un token in
// chiaro sullo schermo è una password scritta su un cartello.
$("scopri").addEventListener("click", (e) => {
  const nascosto = $("linkMaster").classList.toggle("nascosto");
  e.currentTarget.textContent = nascosto ? "Mostra" : "Nascondi";
});

async function copia(testo, bottone, etichetta) {
  try {
    await navigator.clipboard.writeText(testo);
    bottone.textContent = "Copiato";
  } catch {
    bottone.textContent = "Copia non riuscita, selezionalo a mano";
  }
  setTimeout(() => { bottone.textContent = etichetta; }, 2000);
}

$("copia").addEventListener("click", (e) =>
  copia(link, e.currentTarget, "Copia il link della coda"));
$("copiaMaster").addEventListener("click", (e) =>
  copia(linkRiservato, e.currentTarget, "Copia il link riservato"));
$("stampa").addEventListener("click", () => print());

// --- polling -----------------------------------------------------------

polling = avviaPolling({
  leggi: () => api.stato(codice),
  intervallo: () => document.visibilityState === "visible" ? 5000 : 20000,
  aggiorna: (s) => {
    togliCaricamento();
    $("pannello").classList.remove("nascosto");
    document.body.classList.remove("offline");
    $("rete").textContent = "Collegato";
    mostra(s);
  },
  suErrore: (e, n) => {
    if (e.stato === 404) return scomparsa();
    if (n >= 2) {
      document.body.classList.add("offline");
      $("rete").textContent = "Connessione persa, riprovo…";
    }
  },
});

// Evita che un tocco distratto chiuda la gestione mentre c'è gente in attesa.
addEventListener("beforeunload", (e) => {
  if (ultimo && ultimo.last > ultimo.cur) e.preventDefault();
});
