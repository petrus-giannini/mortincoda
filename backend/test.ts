// deno task test
//
// La parte che conta è "concorrenza": venti persone che inquadrano il QR
// nello stesso momento sono lo scenario che rompe un contatore fatto male,
// ed è l'unico che non si scopre provando a mano.

import { assert, assertEquals } from "@std/assert";
import { gestisci, nuovaMedia } from "./main.ts";

let ip = 0;
const nuovoIp = () => `10.0.${(++ip >> 8) & 255}.${ip & 255}`;

function post(percorso: string, corpo: unknown = {}, ipFisso?: string) {
  return gestisci(
    new Request("http://test" + percorso, {
      method: "POST",
      headers: {
        "content-type": "text/plain",
        "x-forwarded-for": ipFisso ?? nuovoIp(),
      },
      body: JSON.stringify(corpo),
    }),
  );
}

const get = (percorso: string) => gestisci(new Request("http://test" + percorso));

async function nuovaCoda(nome = "Prova") {
  const r = await post("/api/queues", { nome });
  return await r.json() as { codice: string; token: string; nome: string };
}

const stato = async (c: string) => await (await get(`/api/q/${c}`)).json();

// ---------------------------------------------------------------- creazione

Deno.test("crea una coda con codice e token distinti", async () => {
  const r = await post("/api/queues", { nome: "  Studio   Rossi  " });
  assertEquals(r.status, 201);
  const q = await r.json();
  assertEquals(q.codice.length, 8);
  assertEquals(q.token.length, 26);
  assertEquals(q.nome, "Studio Rossi", "gli spazi ripetuti vengono normalizzati");
  assert(
    !/[01OIL]/.test(q.codice + q.token),
    "niente caratteri confondibili: il codice viene letto ad alta voce",
  );
});

Deno.test("rifiuta un nome troppo corto", async () => {
  assertEquals((await post("/api/queues", { nome: "x" })).status, 400);
});

Deno.test("300 code, nessuna collisione di codice", async () => {
  const codici = new Set<string>();
  for (let i = 0; i < 300; i++) codici.add((await nuovaCoda("C" + i)).codice);
  assertEquals(codici.size, 300);
});

// ------------------------------------------------------------- concorrenza

for (const N of [25, 60]) {
  Deno.test(`${N} prenotazioni simultanee ricevono numeri distinti`, async () => {
    const q = await nuovaCoda("Burst " + N);
    const esiti = await Promise.all(
      Array.from({ length: N }, () => post(`/api/q/${q.codice}/ticket`)),
    );
    const numeri = (await Promise.all(esiti.map((e) => e.json())))
      .filter((d) => d.n).map((d) => d.n as number);

    assertEquals(numeri.length, N, "nessuna richiesta persa");
    assertEquals(new Set(numeri).size, N, "nessun numero doppio");
    assertEquals(Math.min(...numeri), 1);
    assertEquals(Math.max(...numeri), N, "sequenza contigua");
  });
}

Deno.test("prenotazioni e chiamate in parallelo non si disturbano", async () => {
  const q = await nuovaCoda("Misto");
  await Promise.all(Array.from({ length: 10 }, () => post(`/api/q/${q.codice}/ticket`)));

  const esiti = await Promise.all([
    ...Array.from({ length: 15 }, () => post(`/api/q/${q.codice}/ticket`)),
    ...Array.from({ length: 5 }, () => post(`/api/q/${q.codice}/next`, { token: q.token })),
  ]);
  assert(esiti.every((e) => e.ok), "nessun conflitto fra le due popolazioni di scrittori");

  const s = await stato(q.codice);
  assertEquals(s.last, 25);
  assertEquals(s.cur, 5);
});

// ----------------------------------------------------------- autorizzazione

Deno.test("i comandi del master richiedono il token", async () => {
  const q = await nuovaCoda();
  assertEquals((await post(`/api/q/${q.codice}/next`, {})).status, 403);
  assertEquals((await post(`/api/q/${q.codice}/next`, { token: "X".repeat(26) })).status, 403);
  assertEquals(
    (await post(`/api/q/${q.codice}/next`, { token: q.token.toLowerCase() })).status,
    403,
  );
});

Deno.test("lo stato pubblico non contiene segreti", async () => {
  const q = await nuovaCoda();
  const testo = await (await get(`/api/q/${q.codice}`)).text();
  assert(!testo.includes("adminHash"));
  assert(!testo.includes(q.token));
  assert(testo.length < 200, `payload di polling compatto: ${testo.length} byte`);
});

// ------------------------------------------------------------- media mobile

Deno.test("la media mobile scarta pause e rimbalzi", () => {
  const c = (chiamatoIl: number, media = 90_000, serviti = 5) =>
    // deno-lint-ignore no-explicit-any
    ({ chiamatoIl, mediaServizioMs: media, serviti } as any);
  const ora = Date.now();

  assertEquals(nuovaMedia(c(0, 0, 0), ora).contato, false, "prima chiamata");
  assertEquals(nuovaMedia(c(ora - 40 * 60_000), ora).contato, false, "pausa di 40 min");
  assertEquals(nuovaMedia(c(ora - 500), ora).contato, false, "doppio click");
  assertEquals(nuovaMedia(c(ora - 7 * 60_000), ora).contato, false, "oltre 4x la media");
  assertEquals(nuovaMedia(c(ora - 5 * 60_000), ora).contato, true, "sotto 4x la media");
  assertEquals(
    nuovaMedia(c(ora - 10 * 60_000, 600_000), ora).contato,
    true,
    "con media alta il tetto resta 15 min",
  );

  const n = nuovaMedia(c(ora - 100_000), ora);
  assertEquals(n.media, 93_000, "alfa 0.3 su una media di 90 s");
  assertEquals(nuovaMedia(c(ora - 120_000, 0, 0), ora).media, 120_000, "primo campione");
});

Deno.test("una pausa nel mezzo non avvelena la stima", async () => {
  const q = await nuovaCoda("Tempo");
  for (let i = 0; i < 6; i++) await post(`/api/q/${q.codice}/ticket`);

  const vero = Date.now;
  let t = vero();
  Date.now = () => t;
  try {
    await post(`/api/q/${q.codice}/next`, { token: q.token });
    for (const dt of [100_000, 110_000, 95_000, 1_800_000, 105_000]) {
      t += dt; // il quarto salto è una pausa da 30 minuti
      await post(`/api/q/${q.codice}/next`, { token: q.token });
    }
  } finally {
    Date.now = vero;
  }

  const s = await stato(q.codice);
  assertEquals(s.cur, 6);
  assertEquals(s.srv, 4, "quattro campioni accettati su cinque intervalli");
  assert(s.avg > 95_000 && s.avg < 110_000, `media plausibile: ${Math.round(s.avg / 1000)} s`);
});

// ----------------------------------------------------------------- comandi

Deno.test("richiama, correggi, chiudi", async () => {
  const q = await nuovaCoda("Controlli");
  const T = { token: q.token };

  assertEquals(
    (await post(`/api/q/${q.codice}/recall`, T)).status,
    200,
    "richiamare prima di aver chiamato non rompe nulla",
  );

  for (let i = 0; i < 5; i++) await post(`/api/q/${q.codice}/ticket`);
  await post(`/api/q/${q.codice}/next`, T);
  await post(`/api/q/${q.codice}/next`, T);

  const prima = (await stato(q.codice)).rs;
  await post(`/api/q/${q.codice}/recall`, T);
  assertEquals((await stato(q.codice)).rs, prima + 1);

  await post(`/api/q/${q.codice}/set`, { ...T, inServizio: 1 });
  assertEquals((await stato(q.codice)).cur, 1, "si può tornare su un numero già passato");

  await post(`/api/q/${q.codice}/set`, { ...T, inServizio: 999 });
  assertEquals((await stato(q.codice)).cur, 5, "limitato ai numeri emessi");

  await post(`/api/q/${q.codice}/set`, { ...T, inServizio: -5 });
  assertEquals((await stato(q.codice)).cur, 0, "limitato a zero");

  await post(`/api/q/${q.codice}/set`, { ...T, aperta: false });
  assertEquals((await post(`/api/q/${q.codice}/ticket`)).status, 403);

  await post(`/api/q/${q.codice}/set`, { ...T, aperta: true });
  assertEquals((await post(`/api/q/${q.codice}/ticket`)).status, 201);

  await post(`/api/q/${q.codice}/set`, { ...T, inServizio: 6 });
  assertEquals((await post(`/api/q/${q.codice}/next`, T)).status, 409, "nessuno in attesa");
});

Deno.test("il limite per IP vale solo sulle prenotazioni", async () => {
  const q = await nuovaCoda("Limite");
  const fisso = "10.9.9.9";
  const esiti: number[] = [];
  for (let i = 0; i < 9; i++) {
    esiti.push((await post(`/api/q/${q.codice}/ticket`, {}, fisso)).status);
  }
  assertEquals(esiti.filter((s) => s === 201).length, 6);
  assertEquals(esiti.filter((s) => s === 429).length, 3);
  assertEquals((await post(`/api/q/${q.codice}/ticket`)).status, 201, "altro IP non penalizzato");
});

// --------------------------------------------------------------- protocollo

Deno.test("protocollo HTTP", async () => {
  const q = await nuovaCoda();
  assertEquals((await get("/api/q/ZZZZZZZZ")).status, 404);
  assertEquals((await get(`/api/q/${q.codice.toLowerCase()}`)).status, 200, "codice case-insensitive");
  assertEquals((await get(`/api/q/${q.codice}/next`)).status, 405);

  const pre = await gestisci(new Request("http://test/api/q/" + q.codice, { method: "OPTIONS" }));
  assertEquals(pre.status, 204);
  assert(pre.headers.get("access-control-allow-origin"));

  const rotto = await gestisci(
    new Request("http://test/api/queues", { method: "POST", body: "non-json" }),
  );
  assertEquals(rotto.status, 400, "corpo illeggibile dà 400, non 500");
});
