import {
  adesso,
  api,
  attivaAvvisi,
  avviaPolling,
  dimentica,
  formattaAttesa,
  notifica,
  parametro,
  plurale,
  ricorda,
  ricordato,
  rilasciaSchermo,
  suona,
} from "./comune.js";

const $ = (id) => document.getElementById(id);
const codice = parametro("c").toUpperCase();
const CHIAVE = `ec:num:${codice}`;

if (!codice) location.replace("index.html");

// Il numero vive nel browser e nell'URL. Il server non ne tiene traccia:
// un biglietto non dà nessun privilegio, quindi non c'è niente da validare.
let mio = Number(parametro("n")) || ricordato(CHIAVE) || null;
if (mio) ricorda(CHIAVE, mio);

let ultimo = null;
let avvisiAttivi = false;
let giaAvvisato = null; // "numeroChiamato:contatoreRichiami"
let preavvisato = false;
let polling = null;

// --- stima -------------------------------------------------------------

/** Turni mancanti al mio numero. 0 = tocca a me, negativo = turno passato. */
const turni = (s) => mio - s.cur;

function stimaMs(s) {
  if (s.srv < 3 || s.avg <= 0) return null;
  const trascorso = s.ct ? adesso() - s.ct : 0;
  return Math.max(0, turni(s) * s.avg - trascorso);
}

// --- disegno -----------------------------------------------------------

function mostra(s) {
  ultimo = s;
  $("insegna1").textContent = s.nome;
  $("insegna2").textContent = s.nome;

  if (!mio) {
    schermata("ingresso");
    $("stacca").disabled = !s.open;
    $("stacca").textContent = s.open ? "Stacca il numero" : "Prenotazioni chiuse";
    $("situazione").textContent = s.open
      ? (s.cur ? `Ora è servito il numero ${s.cur}. ` : "") +
        `${plurale(Math.max(0, s.last - s.cur), "persona in attesa", "persone in attesa")}.`
      : "Chi gestisce lo sportello ha chiuso le prenotazioni.";
    return;
  }

  schermata("attesa");
  const t = turni(s);
  const davanti = Math.max(0, t - 1);
  const ms = stimaMs(s);

  $("mio").textContent = mio;
  $("servito").textContent = s.cur || "—";
  $("davanti").textContent = t > 0 ? davanti : "—";
  $("stima").textContent = t > 0 ? (ms === null ? "—" : formattaAttesa(ms)) : "—";

  document.body.classList.toggle("turno", t === 0);
  document.body.classList.toggle("vicino", t > 0 && t <= 2);
  document.body.classList.toggle("passato", t < 0);

  if (t === 0) {
    $("etichettaNumero").textContent = "Tocca a te";
    $("messaggio").textContent = "Presentati allo sportello.";
    document.title = `▶ Tocca a te — ${mio}`;
  } else if (t < 0) {
    $("etichettaNumero").textContent = "Il tuo turno è passato";
    $("messaggio").textContent =
      `Ora è servito il numero ${s.cur}. Rivolgiti allo sportello: il tuo numero può essere richiamato.`;
    document.title = `Turno passato — ${mio}`;
  } else if (t === 1) {
    $("etichettaNumero").textContent = "Il tuo numero";
    $("messaggio").textContent = "Sei il prossimo. Avvicinati allo sportello.";
    document.title = `(1) ${mio} — sei il prossimo`;
  } else {
    $("etichettaNumero").textContent = "Il tuo numero";
    $("messaggio").textContent = davanti === 0
      ? "In attesa."
      : `${plurale(davanti, "persona prima", "persone prima")} di te.`;
    document.title = `(${davanti}) ${mio} — in coda`;
  }

  $("promemoria").classList.toggle("nascosto", t <= 0);
  $("attiva").classList.toggle("nascosto", avvisiAttivi || t < 0);

  avvisa(s, t);
}

function schermata(quale) {
  $("caricamento").classList.add("nascosto");
  for (const id of ["ingresso", "attesa", "assente"]) {
    $(id).classList.toggle("nascosto", id !== quale);
  }
}

// --- avvisi ------------------------------------------------------------
// La chiave "numero:richiami" rende l'avviso idempotente sotto polling:
// si ripete solo se il master cambia numero o preme "richiama".

function avvisa(s, t) {
  if (t === 0) {
    const chiave = `${s.cur}:${s.rs}`;
    if (giaAvvisato !== chiave) {
      giaAvvisato = chiave;
      suona(true);
      notifica("Tocca a te", `${s.nome} — numero ${mio}`);
    }
    preavvisato = false;
    return;
  }
  giaAvvisato = null;
  if (t > 0 && t <= 2 && !preavvisato) {
    preavvisato = true;
    suona(false);
    notifica("Manca poco", `${s.nome} — sei a ${plurale(t, "turno", "turni")} dal tuo`);
  }
  if (t > 2) preavvisato = false;
}

// --- azioni ------------------------------------------------------------

$("stacca").addEventListener("click", async (e) => {
  e.currentTarget.disabled = true;
  e.currentTarget.textContent = "Un momento…";
  try {
    const r = await api.ticket(codice);
    mio = r.n;
    ricorda(CHIAVE, mio);
    history.replaceState(null, "", `q.html?c=${codice}&n=${mio}`);
    mostra(r);
    // L'audio va sbloccato da un gesto: questo è l'unico momento sicuro.
    attiva();
  } catch (err) {
    const p = $("erroreIngresso");
    p.textContent = err.stato === 429
      ? "Hai già staccato diversi numeri. Attendi qualche minuto."
      : `Non è stato possibile staccare il numero: ${err.message}`;
    p.classList.remove("nascosto");
    e.currentTarget.disabled = false;
    e.currentTarget.textContent = "Stacca il numero";
  }
});

async function attiva() {
  const r = await attivaAvvisi();
  avvisiAttivi = true;
  $("attiva").classList.add("nascosto");
  if (!r.audio) {
    $("promemoria").insertAdjacentHTML(
      "beforeend",
      '<p class="tenue" style="margin:.45rem 0 0">Il suono non è disponibile su ' +
        "questo dispositivo: controlla lo schermo.</p>",
    );
  }
}

$("attiva").addEventListener("click", attiva);

$("abbandona").addEventListener("click", () => {
  if (!confirm("Vuoi lasciare la coda? Il numero verrà perso.")) return;
  dimentica(CHIAVE);
  mio = null;
  rilasciaSchermo();
  document.body.classList.remove("turno", "vicino", "passato");
  history.replaceState(null, "", `q.html?c=${codice}`);
  if (ultimo) mostra(ultimo);
  polling?.subito();
});

// --- polling -----------------------------------------------------------
// Fitto quando manca poco, rado quando il turno è lontano. In background si
// rallenta molto: tanto il browser strozza comunque i timer, e la verità si
// ricalcola al rientro in primo piano.

polling = avviaPolling({
  leggi: () => api.stato(codice),
  intervallo: () => {
    if (document.visibilityState !== "visible") return 15000;
    if (!mio || !ultimo) return 10000;
    const t = turni(ultimo);
    if (t < 0) return 20000;
    if (t <= 2) return 3000;
    if (t <= 5) return 5000;
    return 10000;
  },
  aggiorna: (s) => {
    document.body.classList.remove("offline");
    $("rete").textContent = "Collegato";
    mostra(s);
  },
  suErrore: (e, n) => {
    if (e.stato === 404) {
      polling.ferma();
      schermata("assente");
      return;
    }
    if (n >= 2) {
      document.body.classList.add("offline");
      $("rete").textContent = "Connessione persa, riprovo…";
    }
  },
});

// Il testo del dialogo lo decide il browser e non è personalizzabile:
// il messaggio vero sta nella pagina, questo è solo una rete di sicurezza.
addEventListener("beforeunload", (e) => {
  if (mio && ultimo && turni(ultimo) >= 0) e.preventDefault();
});
