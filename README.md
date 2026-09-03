# Eliminacode

Chi gestisce uno sportello apre una coda e mostra un QR code. Chi arriva lo
inquadra, stacca un numero e viene avvisato quando è il suo turno. Nessuna
registrazione da nessuna delle due parti.

- **Backend**: Deno + Deno KV, su Deno Deploy (`console.deno.com`).
- **Frontend**: tre pagine statiche, su GitHub Pages. Nessun framework,
  nessuna richiesta a domini terzi.

```
frontend/
  index.html  index.js     apri una coda
  m.html      m.js         gestisci la coda (numero chiamato, QR, comandi)
  q.html      q.js         stai in coda (numero, stima, avvisi)
  comune.js                client API, orologio, polling, avvisi
  style.css
  vendor/qrcode.js         qrcode-generator, MIT, copia locale
backend/
  main.ts                  routing, CORS, media mobile
  store.ts                 unico file che conosce Deno KV
  test.ts                  deno task test
  smoke.sh                 prova via curl, senza Deno
```

## Il modello dati

Due chiavi per coda, e la separazione è il cuore del progetto:

| chiave | contenuto | chi scrive |
|---|---|---|
| `["coda", CODICE]` | nome, hash del token, numero in servizio, media, flag | solo il master |
| `["contatore", CODICE]` | progressivo dei biglietti | solo chi si prenota |

**I biglietti non esistono lato server.** Un numero non conferisce nessun
privilegio, quindi non c'è niente da validare: il server distribuisce
progressivi, il biglietto vive nel `localStorage` del telefono e nell'URL
(`q.html?c=CODICE&n=37`). Non viene memorizzato nessun dato riferibile a una
persona, e non c'è niente da cancellare quando la coda finisce.

Tenere il contatore separato dal record non è pulizia formale: se stanno
insieme, venti persone che inquadrano il QR nello stesso momento collidono
fra loro e con il master che preme "prossimo". La suite di test verifica
sessanta prenotazioni simultanee.

Entrambe le chiavi hanno una TTL di 24 ore rinnovata a ogni scrittura: le
code abbandonate spariscono da sole, senza job di pulizia.

## Due segreti, non uno

- **codice coda** — 8 caratteri, ~40 bit, **pubblico**, va nel QR. Non
  protegge niente: impedisce solo di enumerare le code altrui.
- **token master** — 26 caratteri, ~128 bit, **segreto**, salvato in forma
  hash sul server. Viaggia nel frammento dell'URL (`m.html?c=X#TOKEN`), che
  il browser non invia mai al server: non finisce nei log né nel Referer.
  Al primo caricamento passa in `localStorage` e sparisce dalla barra degli
  indirizzi.

Perso il token, persa la coda. È una scelta: senza account non c'è recupero
possibile, e con una TTL di 24 ore il danno si esaurisce da solo.

## API

Sei endpoint. I `POST` hanno corpo `text/plain` contenente JSON: così restano
richieste "semplici" e il browser non aggiunge un preflight `OPTIONS` a ogni
azione. Il token del master va nel corpo, mai in un header custom, per lo
stesso motivo.

| | | |
|---|---|---|
| `POST` | `/api/queues` | `{nome}` → `{codice, token, nome}` |
| `GET` | `/api/q/:codice` | stato pubblico, ~110 byte |
| `POST` | `/api/q/:codice/ticket` | → `{n, ...stato}` |
| `POST` | `/api/q/:codice/next` | `{token}` |
| `POST` | `/api/q/:codice/recall` | `{token}` — nuovo avviso forte |
| `POST` | `/api/q/:codice/set` | `{token, inServizio?, aperta?}` |

Ogni risposta include `now`, il tempo del server: il client ne ricava lo
scarto e calcola le stime su quello. L'orologio di un telefono può essere
sfasato di minuti, e un conto alla rovescia che parte da un numero negativo
è un bug che si vede subito.

`set` esiste perché `next` da solo non basta: quando uno non si presenta il
master avanza, e quando quello arriva in ritardo bisogna poter tornare al suo
numero. Il client del ritardatario sta ancora facendo polling, quindi riceve
la chiamata e suona senza bisogno di altro.

## La stima dei tempi

Media mobile esponenziale (α = 0,3) sull'intervallo fra due chiamate, un solo
float. Scarta gli intervalli sotto i 3 secondi (doppi click) e sopra i 15
minuti, o sopra 4 volte la media corrente una volta che la media è
affidabile: senza questa guardia la pausa pranzo del master avvelena la stima
per il resto della giornata. Sotto tre campioni accettati la stima non viene
mostrata affatto.

## Gli avvisi, e cosa il browser non concede

La pagina di chi aspetta **deve restare aperta**. Con la scheda chiusa o lo
schermo bloccato timer, audio e polling si fermano: l'unica alternativa vera
sono le Web Push con service worker, che su iOS richiedono l'installazione
come PWA. Fuori dall'MVP.

Quindi:

- L'audio si sblocca con un gesto dell'utente. Il momento è quello in cui
  stacca il numero: lì parte un beep di conferma che tiene vivo
  l'`AudioContext`.
- **Su iPhone con l'interruttore silenzioso attivo non c'è nessun canale
  sonoro**, e `navigator.vibrate` non esiste su Safari. Per questo l'avviso
  visivo non è un contorno: allo scattare del turno l'intera pagina diventa
  rossa. È l'unica cosa che funziona ovunque.
- `beforeunload` mostra un dialogo di sistema con un testo deciso dal
  browser: quello che scrivi tu viene ignorato. È una rete di sicurezza sul
  desktop, non il messaggio. Il messaggio sta nella pagina.
- Wake Lock quando manca poco, `document.title` che porta il conto, e una
  `Notification` se la scheda è nascosta ma viva.

L'avviso è idempotente sotto polling: il client ricorda la coppia
`numeroChiamato:contatoreRichiami` e risuona solo se cambia. Il pulsante
"richiama" del master incrementa il contatore, quindi un sollecito rifà
suonare senza toccare il numero.

## Deploy

Un solo repository, due destinazioni. `backend/` va su Deno Deploy, tutto il
resto della cartella del frontend va su GitHub Pages. Nessuna delle due parti
sa dove sta l'altra: si parlano solo via HTTP, e l'unico collegamento è la
costante `API` in `comune.js` da un lato e la variabile `ORIGINI` dall'altro.

### 1. Repository

GitHub Pages, quando pubblica da un branch, accetta solo la radice o la
cartella `/docs`. Il modo con meno pezzi in movimento è quindi rinominare:

```sh
git mv frontend docs
```

La struttura diventa `docs/` (statico, va su Pages) e `backend/` (va su Deno
Deploy). In alternativa si tiene `frontend/` e si pubblica con un workflow
GitHub Actions.

Il file `docs/.nojekyll` deve restare: senza, GitHub Pages passa il sito per
Jekyll, che **esclude la cartella `vendor/`** e manda in 404 la libreria QR.

### 2. Backend su Deno Deploy

Su [console.deno.com](https://console.deno.com):

1. Crea l'organizzazione, se non ce l'hai.
2. **Databases → Provision Database → Deno KV**, dandogli un nome. Su questa
   piattaforma il KV non è automatico: senza questo passo `Deno.openKv()`
   non ha un database a cui collegarsi.
3. **Assign** il database all'app (si può fare anche dopo averla creata).
4. Crea l'app dal repository GitHub. In "Edit app config" imposta
   **App directory = `backend`**. È l'unica impostazione che deve stare in
   dashboard: l'entrypoint lo legge già da `backend/deno.json`.
5. Variabile d'ambiente, contesto Production:

   ```
   ORIGINI=https://TUOUTENTE.github.io
   ```

   Solo schema e host. Il percorso del repository non fa parte dell'origine,
   quindi niente `/eliminacode` in fondo.

Annota l'URL dell'app, del tipo `https://NOME-APP.deno.dev`.

### 3. Frontend su GitHub Pages

In `docs/comune.js`, la prima riga utile:

```js
const API = "https://NOME-APP.deno.dev";
```

Poi **Settings → Pages → Deploy from a branch → main / docs**.

L'URL della coda diventa
`https://TUOUTENTE.github.io/REPO/q.html?c=CODICE`, e la pagina del master lo
compone da sola per il QR: non c'è nessun indirizzo scritto a mano.

### 4. In locale

```sh
cd backend && deno task dev            # API su :8000, KV su file
cd docs && python3 -m http.server 3000
```

Con `API = "http://localhost:8000"` e `ORIGINI` non impostata (senza quella
variabile il CORS accetta qualunque origine, che in locale è comodo e in
produzione non va mai lasciato così).

## Test

Tre modi, in ordine di completezza.

**Con Deno installato** — la suite vera, l'unica che copre la concorrenza:

```sh
cd backend && deno task test
```

Copre: emissione concorrente a 25 e 60 richieste, prenotazioni e chiamate in
parallelo, autorizzazione, media mobile con pausa simulata a orologio
controllato, limite per IP, correzioni e chiusura, protocollo HTTP.

**Senza Deno, su GitHub** — `.github/workflows/test.yml` esegue la stessa
suite a ogni push su `backend/`. Il risultato si legge nella scheda Actions,
e si può lanciare a mano da lì con "Run workflow".

**Senza niente** — `smoke.sh` prova un backend già in esecuzione usando solo
`sh` e `curl`:

```sh
sh backend/smoke.sh                            # contro localhost:8000
sh backend/smoke.sh https://tua-app.deno.dev   # contro il deploy
```

Verifica raggiungibilità, collegamento al KV, autorizzazione, forma delle
risposte e CORS. Non sostituisce la suite: il suo test di concorrenza dice
solo che fra i numeri emessi non ce ne sono di doppi, perché sul deploy la
piattaforma riscrive `x-forwarded-for` e il limite per IP taglia comunque le
richieste. In locale si aggira con `TICKET_PER_IP=1000 deno task dev`.

> La suite su `Deno.test` è stata sviluppata e fatta passare su un harness
> Node con uno shim di Deno KV, ma non è stata eseguita sotto Deno: lanciala
> per prima. `smoke.sh` invece è stato eseguito contro il backend servito da
> un vero server HTTP, e passa.

Anche la macchina a stati di `q.js` è stata provata su un DOM finto
(avvicinamento, turno, sollecito, turno passato, ritardatario richiamato,
orologio sfasato di un'ora), ma quei test non sono nel repo perché
richiedono impalcature che varrebbe la pena riscrivere solo su un runner
vero.

## Quello che i test non possono dirti

Da provare su un telefono, in quest'ordine:

1. **iPhone con lo switch silenzioso.** Se conferma che non suona, il testo
   delle istruzioni va rinforzato.
2. **Ritorno dal background** dopo dieci minuti a schermo spento: il poll al
   `visibilitychange` deve precedere il render, altrimenti si vede per mezzo
   secondo una situazione vecchia e parte un allarme fuori tempo.
3. **Modalità aereo per un minuto**: deve comparire "connessione persa" e
   deve riagganciarsi da solo. Il fallimento silenzioso è peggio dell'errore.

## Punti aperti

- Il limite per IP vive nella memoria dell'isolate: è una barriera contro la
  distrazione, non contro un attacco. Senza autenticazione va bene così.
- Le due chiavi hanno TTL indipendenti. Se il contatore scade prima della
  coda, il numero riparte dal numero in servizio: nessun biglietto
  duplicato, ma un salto visibile. `pulisci()` in `store.ts` raccoglie gli
  orfani, agganciata a un `Deno.cron` giornaliero.
- Il piano gratuito di Deno Deploy dà 1 milione di richieste al mese, cioè
  circa 4.400 sessioni di attesa. Sopra quella soglia si passa a Cloudflare:
  si riscrive `store.ts` e basta.
- Deno KV scrive negli Stati Uniti (us-east4) con repliche di lettura in
  Europa, e Deno stesso dice che non è adatto a chi ha requisiti di
  residenza dei dati in UE. Qui non è un problema perché non viene
  memorizzato nessun dato personale: solo il nome della coda, un contatore e
  l'hash di un token. È il motivo pratico per cui i biglietti non esistono
  lato server.
