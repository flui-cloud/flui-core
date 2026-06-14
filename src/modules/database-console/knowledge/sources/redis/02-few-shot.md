---
title: Worked examples
---

Examples of the request → output-JSON mapping. Key names come only from the user's question.

**"quante chiavi ci sono?"**

```json
{
  "command": "DBSIZE",
  "explanation": "Restituisce il numero totale di chiavi nel database corrente."
}
```

**"trova le chiavi che iniziano con session:"**

```json
{
  "command": "SCAN 0 MATCH session:* COUNT 100",
  "explanation": "Itera le chiavi che corrispondono al pattern, partendo dal cursore 0 (la console continua con il cursore restituito). SCAN non blocca il server come KEYS."
}
```

**"mostrami tutti i campi della chiave user:42"**

```json
{
  "command": "HGETALL user:42",
  "explanation": "Legge tutti i campi/valori dell'hash user:42. Se non fosse un hash, usa prima TYPE user:42."
}
```

**"qual è il TTL di cart:99?"**

```json
{
  "command": "TTL cart:99",
  "explanation": "Secondi rimanenti prima della scadenza (-1 = nessuna scadenza, -2 = chiave assente)."
}
```

**"top 10 della classifica leaderboard"**

```json
{
  "command": "ZRANGE leaderboard 0 9 REV WITHSCORES",
  "explanation": "I 10 membri con punteggio più alto, con i rispettivi score."
}
```

**"imposta feature:flag a on per un'ora"** (write → warn)

```json
{
  "command": "SET feature:flag on EX 3600",
  "explanation": "Imposta la chiave con scadenza 1 ora. È una scrittura: viene eseguita solo dopo che disabiliti la modalità read-only e confermi."
}
```

**"cancella le chiavi temporanee"** (destructive, pattern not named precisely → preview first)

```json
{
  "command": "SCAN 0 MATCH temp:* COUNT 100",
  "explanation": "Prima elenchiamo le chiavi temp:* per verificarne la portata. Per cancellarle davvero, dopo aver controllato, disabilita read-only ed esegui DEL sulle chiavi mostrate: è un'operazione distruttiva."
}
```

**richiesta senza chiave indicata**

```json
{
  "command": "",
  "explanation": "Dimmi il nome (o il pattern) della chiave su cui vuoi operare e genero il comando pronto da eseguire."
}
```
