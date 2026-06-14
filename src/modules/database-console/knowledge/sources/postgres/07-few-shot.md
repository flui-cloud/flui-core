---
title: Worked examples
---

Examples of the request → output-JSON mapping. (Schemas here are illustrative; in a real
turn, use the provided schema.)

**"how many users signed up this week?"**

```json
{
  "sql": "SELECT count(*) AS signups\nFROM users\nWHERE created_at >= date_trunc('week', current_date)",
  "explanation": "Counts users created since the start of the current calendar week."
}
```

**"show the 10 biggest orders with the customer email"**

```json
{
  "sql": "SELECT o.id, o.total, c.email\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nORDER BY o.total DESC\nLIMIT 10",
  "explanation": "Top 10 orders by total, joined to the customer for their email."
}
```

**"daily revenue for the last 30 days"**

```json
{
  "sql": "SELECT date_trunc('day', created_at) AS day, sum(total) AS revenue\nFROM orders\nWHERE created_at >= now() - interval '30 days'\nGROUP BY 1\nORDER BY 1",
  "explanation": "Sums order totals per day over the last 30 days."
}
```

**"delete the expired sessions"** (destructive → preview first, warn)

```json
{
  "sql": "SELECT id, expires_at\nFROM sessions\nWHERE expires_at < now()\nLIMIT 100",
  "explanation": "These are the expired sessions. This is a read-only preview — to actually remove them, disable read-only and run: DELETE FROM sessions WHERE expires_at < now(). That permanently deletes data."
}
```

**"what's the average basket value by country?"**

```json
{
  "sql": "SELECT c.country, round(avg(o.total)::numeric, 2) AS avg_basket\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nGROUP BY c.country\nORDER BY avg_basket DESC",
  "explanation": "Average order total grouped by the customer's country, rounded to 2 decimals."
}
```

**asking for a column that isn't in the schema**

```json
{
  "sql": "",
  "explanation": "There's no `phone` column on `customers` in this database. The closest fields are `email` and `country` — want one of those instead?"
}
```

**"create a customers table"** (DDL, purpose inferable → concrete, runnable design + warn it was inferred — NEVER a skeleton)

```json
{
  "sql": "CREATE TABLE customers (\n  id          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  email       text NOT NULL UNIQUE,\n  full_name   text NOT NULL,\n  country     text,\n  created_at  timestamptz NOT NULL DEFAULT now()\n)",
  "explanation": "I inferred a typical customers schema (id, email, full_name, country, created_at) and types — adjust the columns to fit your data. This changes structure: it runs as a write once you confirm."
}
```

**"create a table for my data"** (too vague to infer responsibly → ask, don't guess)

```json
{
  "sql": "",
  "explanation": "Happy to write the CREATE TABLE — tell me the table name and the columns you need with their types (e.g. id, name text, amount numeric, created_at timestamptz) and I'll generate a ready-to-run statement."
}
```

**"add a phone column to customers"** (ALTER, type inferable)

```json
{
  "sql": "ALTER TABLE customers ADD COLUMN phone text",
  "explanation": "Adds a nullable text `phone` column to `customers` (text fits phone numbers — leading zeros, +, spaces). This changes structure and runs as a write after confirmation."
}
```
