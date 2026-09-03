// Strato di persistenza. È l'unico file che conosce Deno KV.
// Per migrare a Cloudflare (Durable Objects o D1) si riscrive solo questo:
// il resto del backend usa crea / leggi / emetti / aggiorna / pulisci.
//
// Due chiavi per coda, e la separazione non è cosmetica:
//
//   ["coda", CODICE]      il record, scritto SOLO dal master (chiamare,
//                         richiamare, correggere, aprire e chiudere)
//   ["contatore", CODICE] il progressivo dei biglietti, scritto SOLO da
//                         chi si prenota
//
// Tenerli insieme significa far collidere venti persone che scansionano il QR
// nello stesso momento con il master che preme "prossimo". Separati, le due
// popolazioni di scrittori non si contendono mai la stessa chiave.

export interface Coda {
  nome: string;
  adminHash: string;
  inServizio: number;
  chiamatoIl: number; // epoch ms dell'ultima chiamata, 0 se mai chiamato
  richiamiSeq: number;
  mediaServizioMs: number;
  serviti: number; // campioni accettati nella media
  aperta: boolean;
  creataIl: number;
  ver: number;
}

export interface Vista {
  coda: Coda;
  emessi: number;
}

export const TTL_MS = 24 * 60 * 60 * 1000;
const TENTATIVI = 20;

// KV_PATH=":memory:" nei test; in produzione la variabile non si imposta.
const kv = await Deno.openKv(Deno.env.get("KV_PATH") || undefined);

const kCoda = (c: string) => ["coda", c];
const kCont = (c: string) => ["contatore", c];

export class Conflitto extends Error {}

const attendi = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

/** Backoff esponenziale con jitter: senza jitter i client ripartono in fase. */
const pausa = (i: number) => attendi(Math.random() * Math.min(4 * 2 ** i, 250));

export async function crea(codice: string, coda: Coda): Promise<boolean> {
  const r = await kv.atomic()
    .check({ key: kCoda(codice), versionstamp: null })
    .set(kCoda(codice), coda, { expireIn: TTL_MS })
    .set(kCont(codice), { n: 0 }, { expireIn: TTL_MS })
    .commit();
  return r.ok;
}

export async function leggi(codice: string): Promise<Vista | null> {
  const [rc, rn] = await kv.getMany<[Coda, { n: number }]>(
    [kCoda(codice), kCont(codice)],
    { consistency: "strong" },
  );
  if (!rc.value) return null;
  // Se il contatore è scaduto ma la coda no (24 ore senza una prenotazione),
  // il pavimento è il numero in servizio: mai riemettere numeri già chiamati.
  return { coda: rc.value, emessi: rn.value?.n ?? rc.value.inServizio };
}

/**
 * Emette il prossimo biglietto. Read-modify-write con controllo di versione
 * sulla sola chiave del contatore.
 * Restituisce null se la coda non esiste, -1 se le prenotazioni sono chiuse.
 */
export async function emetti(codice: string): Promise<number | null> {
  for (let i = 0; i < TENTATIVI; i++) {
    const [rc, rn] = await kv.getMany<[Coda, { n: number }]>(
      [kCoda(codice), kCont(codice)],
      { consistency: "strong" },
    );
    if (!rc.value) return null;
    if (!rc.value.aperta) return -1;

    const prossimo = Math.max(rn.value?.n ?? 0, rc.value.inServizio) + 1;
    const esito = await kv.atomic()
      .check({ key: kCont(codice), versionstamp: rn.versionstamp })
      .set(kCont(codice), { n: prossimo }, { expireIn: TTL_MS })
      .commit();

    if (esito.ok) return prossimo;
    await pausa(i);
  }
  throw new Conflitto("contatore troppo conteso");
}

/**
 * Legge, applica `muta` al record, riscrive con controllo di versione.
 * Se `muta` restituisce null l'aggiornamento è annullato senza errore.
 * Ogni scrittura rinnova la TTL: le code abbandonate scadono da sole.
 */
export async function aggiorna(
  codice: string,
  muta: (v: Vista) => Coda | null,
): Promise<Vista | null> {
  for (let i = 0; i < TENTATIVI; i++) {
    const [rc, rn] = await kv.getMany<[Coda, { n: number }]>(
      [kCoda(codice), kCont(codice)],
      { consistency: "strong" },
    );
    if (!rc.value) return null;
    const emessi = rn.value?.n ?? rc.value.inServizio;

    const nuova = muta({ coda: structuredClone(rc.value), emessi });
    if (!nuova) return { coda: rc.value, emessi };
    nuova.ver = rc.value.ver + 1;

    const esito = await kv.atomic()
      .check({ key: kCoda(codice), versionstamp: rc.versionstamp })
      .set(kCoda(codice), nuova, { expireIn: TTL_MS })
      .commit();

    if (esito.ok) return { coda: nuova, emessi };
    await pausa(i);
  }
  throw new Conflitto("record troppo conteso");
}

/**
 * Le due chiavi hanno TTL indipendenti, rinnovate dai rispettivi scrittori.
 * Questa passata raccoglie i contatori rimasti orfani quando le TTL divergono.
 * Innocua se non trova nulla: chiamala da un Deno.cron giornaliero.
 */
export async function pulisci(): Promise<number> {
  let rimossi = 0;
  for await (const e of kv.list<{ n: number }>({ prefix: ["contatore"] })) {
    const codice = String(e.key[1]);
    const c = await kv.get<Coda>(kCoda(codice));
    if (!c.value) {
      await kv.delete(e.key);
      rimossi++;
    }
  }
  return rimossi;
}
