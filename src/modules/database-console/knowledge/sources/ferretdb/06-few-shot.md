---
title: Worked examples
---

Examples of the request → output-JSON mapping. Collection/field names come from the structure
summary or the user's question; values come only from the user.

**"mostrami gli utenti admin"**

```json
{
  "shell": "db.users.find({ role: \"admin\" }).limit(20)",
  "explanation": "Elenca gli utenti con ruolo admin (prime 20 righe; allarga con .limit())."
}
```

**"find the user with id 652c8f1e2a4b1c0007a1b2c3"**

```json
{
  "shell": "db.users.findOne({ _id: ObjectId(\"652c8f1e2a4b1c0007a1b2c3\") })",
  "explanation": "Looks the user up by _id. The id is wrapped in ObjectId() so it matches the BSON type."
}
```

**"quanti ordini pagati ci sono?"**

```json
{
  "shell": "db.orders.countDocuments({ status: \"paid\" })",
  "explanation": "Conteggio esatto degli ordini con status \"paid\"."
}
```

**"revenue per category, highest first"**

```json
{
  "shell": "db.products.aggregate([ { $group: { _id: \"$category\", revenue: { $sum: \"$price\" } } }, { $sort: { revenue: -1 } } ])",
  "explanation": "Groups by category and sums price, then sorts descending by revenue."
}
```

**"eventi dopo il primo gennaio 2024"**

```json
{
  "shell": "db.events.find({ createdAt: { $gte: ISODate(\"2024-01-01\") } }).sort({ createdAt: -1 })",
  "explanation": "Filtra per data con ISODate e ordina dal più recente. Sola lettura."
}
```

**"set role to editor for that user"** (write → warn)

```json
{
  "shell": "db.users.updateOne({ _id: ObjectId(\"652c8f1e2a4b1c0007a1b2c3\") }, { $set: { role: \"editor\" } })",
  "explanation": "Aggiorna il ruolo dell'utente. È una scrittura: viene eseguita solo dopo aver disattivato read-only e confermato."
}
```

**"cancella i vecchi log"** (destructive, scope fuzzy → preview first)

```json
{
  "shell": "db.logs.countDocuments({ createdAt: { $lt: ISODate(\"2023-01-01\") } })",
  "explanation": "Prima contiamo i log anteriori al 2023 per verificare la portata. Per cancellarli, dopo il controllo, disattiva read-only ed esegui db.logs.deleteMany({ createdAt: { $lt: ISODate(\"2023-01-01\") } }): è distruttivo."
}
```

**"distinct order statuses"**

```json
{
  "shell": "db.orders.distinct(\"status\")",
  "explanation": "Returns the list of distinct status values across the orders collection."
}
```

**richiesta senza collezione indicata**

```json
{
  "shell": "",
  "explanation": "Dimmi su quale collezione vuoi operare (vedi 'show collections') e genero la statement pronta."
}
```
