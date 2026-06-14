---
title: Worked examples
---

Examples of the request → output-JSON mapping. (Schemas here are illustrative; in a real
turn, use the provided schema.)

**"how many users signed up this week?"**

```json
{
  "sql": "SELECT count(*) AS signups\nFROM users\nWHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)",
  "explanation": "Counts users created since Monday of the current week (WEEKDAY is 0 on Monday)."
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
  "sql": "SELECT DATE(created_at) AS day, sum(total) AS revenue\nFROM orders\nWHERE created_at >= NOW() - INTERVAL 30 DAY\nGROUP BY day\nORDER BY day",
  "explanation": "Sums order totals per calendar day over the last 30 days."
}
```

**"delete the expired sessions"** (destructive → preview first, warn)

```json
{
  "sql": "SELECT id, expires_at\nFROM sessions\nWHERE expires_at < NOW()\nLIMIT 100",
  "explanation": "These are the expired sessions. This is a read-only preview — to actually remove them, disable read-only and run: DELETE FROM sessions WHERE expires_at < NOW(). That permanently deletes data."
}
```

**"what's the average basket value by country?"**

```json
{
  "sql": "SELECT c.country, ROUND(avg(o.total), 2) AS avg_basket\nFROM orders o\nJOIN customers c ON c.id = o.customer_id\nGROUP BY c.country\nORDER BY avg_basket DESC",
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
  "sql": "CREATE TABLE customers (\n  id          BIGINT AUTO_INCREMENT PRIMARY KEY,\n  email       VARCHAR(255) NOT NULL UNIQUE,\n  full_name   VARCHAR(255) NOT NULL,\n  country     VARCHAR(2),\n  created_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP\n)",
  "explanation": "I inferred a typical customers schema (id, email, full_name, country, created_at) and MariaDB types — adjust the columns to fit your data. This changes structure: it runs as a write once you confirm."
}
```

**"create a table for my data"** (too vague to infer responsibly → ask, don't guess)

```json
{
  "sql": "",
  "explanation": "Happy to write the CREATE TABLE — tell me the table name and the columns you need with their types (e.g. id, name VARCHAR(255), amount DECIMAL(10,2), created_at DATETIME) and I'll generate a ready-to-run statement."
}
```

**"add a phone column to customers"** (ALTER, type inferable)

```json
{
  "sql": "ALTER TABLE customers ADD COLUMN phone VARCHAR(32)",
  "explanation": "Adds a nullable VARCHAR(32) `phone` column to `customers` (fits numbers with leading zeros, +, spaces). This changes structure and runs as a write after confirmation."
}
```
