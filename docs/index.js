import { api, ricorda, ricordato } from "./comune.js";

const $ = (id) => document.getElementById(id);
const campoNome = $("nome");
const bottone = $("crea");
const errore = $("errore");

// Se il master ha già una coda su questo dispositivo, offrigli la scorciatoia
// invece di fargli aprire un doppione.
const ultima = ricordato("ec:ultimaCoda");
if (ultima?.codice && ultima?.token) {
  const a = $("ultima");
  a.href = `m.html?c=${ultima.codice}#${ultima.token}`;
  a.textContent = `Riprendi «${ultima.nome}»`;
  a.classList.remove("nascosto");
  $("nessuna").classList.add("nascosto");
}

async function crea() {
  const nome = campoNome.value.trim();
  errore.classList.add("nascosto");

  if (nome.length < 2) {
    errore.textContent = "Scrivi un nome di almeno due caratteri.";
    errore.classList.remove("nascosto");
    campoNome.focus();
    return;
  }

  bottone.disabled = true;
  bottone.textContent = "Apertura…";
  try {
    const r = await api.crea(nome);
    ricorda("ec:ultimaCoda", r);
    ricorda(`ec:master:${r.codice}`, r.token);
    location.href = `m.html?c=${r.codice}#${r.token}`;
  } catch (e) {
    errore.textContent = `Non è stato possibile aprire la coda: ${e.message}. Riprova.`;
    errore.classList.remove("nascosto");
    bottone.disabled = false;
    bottone.textContent = "Apri la coda";
  }
}

bottone.addEventListener("click", crea);
campoNome.addEventListener("keydown", (e) => { if (e.key === "Enter") crea(); });
campoNome.addEventListener("input", () => errore.classList.add("nascosto"));
campoNome.focus();
