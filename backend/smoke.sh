#!/bin/sh
# Smoke test end-to-end contro un backend già in esecuzione.
# Non richiede Deno, né jq, né altro: solo sh e curl.
#
#   sh smoke.sh                              # contro localhost:8000
#   sh smoke.sh https://tua-app.deno.dev     # contro il deploy
#
# Verifica che il servizio sia raggiungibile, che il KV sia collegato, che
# l'autorizzazione tenga e che le risposte abbiano la forma giusta.
# Il test di concorrenza vero resta "deno task test": qui si controlla solo
# che fra i numeri emessi non ce ne siano di doppi.

BASE="${1:-http://localhost:8000}"
ORIGINE="${2:-https://esempio.github.io}"
TMP=$(mktemp -d) || exit 1
trap 'rm -rf "$TMP"' EXIT

ko=0
ok() {
  if [ "$1" = 1 ]; then printf '  ok   %s\n' "$2"
  else printf '  KO   %s\n' "$2"; ko=$((ko + 1)); fi
}
vero() { [ "$1" = "$2" ] && echo 1; }

# Le risposte viaggiano come "STATO<TAB>CORPO" in una variabile.
POST() {
  printf '%s\t%s' \
    "$(curl -s -o "$TMP/b" -w '%{http_code}' -X POST \
        -H 'content-type: text/plain' -H "origin: $ORIGINE" \
        -d "$2" "$BASE$1")" \
    "$(cat "$TMP/b")"
}
GET() {
  printf '%s\t%s' \
    "$(curl -s -o "$TMP/b" -w '%{http_code}' -H "origin: $ORIGINE" "$BASE$1")" \
    "$(cat "$TMP/b")"
}
st() { printf '%s' "$1" | cut -f1; }
bd() { printf '%s' "$1" | cut -f2-; }
testo() { printf '%s' "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed 's/.*:"//;s/"//'; }
cifra() { printf '%s' "$1" | grep -o "\"$2\":[0-9]*" | head -1 | cut -d: -f2; }

printf '\nBackend: %s\n\n' "$BASE"

# --- il servizio risponde ed è collegato al database ---------------------
r=$(GET /api/q/ZZZZZZZZ)
ok "$(vero "$(st "$r")" 404)" "coda inesistente: 404 (ottenuto $(st "$r"))"
case "$(bd "$r")" in
  *errore*) ok 1 "risposta JSON: routing attivo e KV collegato" ;;
  *) ok 0 "risposta inattesa: $(bd "$r")" ;;
esac

# --- creazione -----------------------------------------------------------
r=$(POST /api/queues '{"nome":"Smoke test"}')
CODICE=$(testo "$(bd "$r")" codice)
TOKEN=$(testo "$(bd "$r")" token)
ok "$(vero "$(st "$r")" 201)" "creazione coda: 201"
ok "$(vero ${#CODICE} 8)" "codice di 8 caratteri: $CODICE"
ok "$(vero ${#TOKEN} 26)" "token di 26 caratteri"
[ -z "$CODICE" ] && { printf '\nCreazione fallita, mi fermo.\n\n'; exit 1; }

r=$(POST /api/queues '{"nome":"x"}')
ok "$(vero "$(st "$r")" 400)" "nome troppo corto: 400"

# --- 25 prenotazioni in parallelo ----------------------------------------
# Ogni richiesta dichiara un x-forwarded-for diverso: senza, in locale
# arrivano tutte dallo stesso IP e il limite di 6 le taglia prima che la
# prova serva a qualcosa. Sul deploy l'header lo riscrive la piattaforma,
# quindi lì il limite scatta comunque: è previsto, vedi la nota sotto.
printf '\n  25 prenotazioni simultanee...\n'
i=1
while [ $i -le 25 ]; do
  curl -s -o "$TMP/t$i" -w '%{http_code} ' -X POST \
    -H 'content-type: text/plain' -H "x-forwarded-for: 10.0.0.$i" \
    -d '{}' "$BASE/api/q/$CODICE/ticket" >> "$TMP/stati" &
  i=$((i + 1))
done
wait

# grep -o invece di sed: i file di curl non finiscono con a capo, quindi
# concatenati formano una riga sola e un sed per riga ne vedrebbe uno solo.
cat "$TMP"/t* 2>/dev/null | grep -o '"n":[0-9]*' | cut -d: -f2 | sort -n > "$TMP/num"
TOT=$(wc -l < "$TMP/num" | tr -d ' ')
UNI=$(sort -u "$TMP/num" | wc -l | tr -d ' ')
MAX=$(tail -1 "$TMP/num")
LIM=$(grep -o 429 "$TMP/stati" | wc -l | tr -d ' ')

ok "$([ "$UNI" = "$TOT" ] && [ "$TOT" -gt 0 ] && echo 1)" \
   "nessun numero doppio ($UNI distinti su $TOT emessi)"
if [ "$LIM" -gt 0 ]; then
  printf '  nota  %s richieste respinte dal limite per IP.\n' "$LIM"
  printf '        Atteso sul deploy. In locale alza il limite:\n'
  printf '        TICKET_PER_IP=1000 deno task dev\n'
else
  ok "$(vero "$TOT" 25)" "25 richieste servite"
  ok "$(vero "$MAX" 25)" "sequenza contigua fino a $MAX"
fi

# --- autorizzazione ------------------------------------------------------
printf '\n'
r=$(POST "/api/q/$CODICE/next" '{}')
ok "$(vero "$(st "$r")" 403)" "next senza token: 403"
r=$(POST "/api/q/$CODICE/next" '{"token":"XXXXXXXXXXXXXXXXXXXXXXXXXX"}')
ok "$(vero "$(st "$r")" 403)" "next con token errato: 403"

# --- comandi del master --------------------------------------------------
POST "/api/q/$CODICE/next" "{\"token\":\"$TOKEN\"}" > /dev/null
r=$(POST "/api/q/$CODICE/next" "{\"token\":\"$TOKEN\"}")
ok "$(vero "$(cifra "$(bd "$r")" cur)" 2)" \
   "due chiamate: in servizio $(cifra "$(bd "$r")" cur)"

r=$(POST "/api/q/$CODICE/recall" "{\"token\":\"$TOKEN\"}")
ok "$(vero "$(cifra "$(bd "$r")" rs)" 1)" "richiama incrementa il contatore di sollecito"

POST "/api/q/$CODICE/set" "{\"token\":\"$TOKEN\",\"aperta\":false}" > /dev/null
r=$(POST "/api/q/$CODICE/ticket" '{}')
ok "$(vero "$(st "$r")" 403)" "a prenotazioni chiuse il ticket è rifiutato: 403"
POST "/api/q/$CODICE/set" "{\"token\":\"$TOKEN\",\"aperta\":true}" > /dev/null

# --- forma delle risposte ------------------------------------------------
printf '\n'
r=$(GET "/api/q/$CODICE"); B=$(bd "$r")
case "$B" in
  *adminHash*|*"$TOKEN"*) ok 0 "lo stato pubblico espone un segreto!" ;;
  *) ok 1 "lo stato pubblico non contiene segreti" ;;
esac
ok "$([ ${#B} -lt 200 ] && echo 1)" "payload di polling: ${#B} byte"
r=$(GET "/api/q/$(printf '%s' "$CODICE" | tr 'A-Z' 'a-z')")
ok "$(vero "$(st "$r")" 200)" "codice insensibile alle maiuscole"

# --- CORS ----------------------------------------------------------------
ACAO=$(curl -s -D - -o /dev/null -X OPTIONS -H "origin: $ORIGINE" \
       "$BASE/api/q/$CODICE" | tr -d '\r' \
       | sed -n 's/^[Aa]ccess-[Cc]ontrol-[Aa]llow-[Oo]rigin: //p')
ok "$([ -n "$ACAO" ] && echo 1)" "preflight OPTIONS risponde"
if [ "$ACAO" = "null" ]; then
  printf '  nota  ORIGINI non ammette %s.\n' "$ORIGINE"
  printf '        Giusto se testi il deploy da un'\''origine diversa;\n'
  printf '        passala come secondo argomento per verificarla.\n'
else
  ok 1 "origine ammessa: $ACAO"
fi

printf '\n'
if [ "$ko" -eq 0 ]; then printf 'Tutti i controlli superati\n\n'; exit 0
else printf '%s CONTROLLI FALLITI\n\n' "$ko"; exit 1; fi
