-- Πίνακας: κάθε γραμμή = ένα ολόκληρο τιμολόγιο
CREATE TABLE invoices (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  workspace_id TEXT NOT NULL,
  supplier_name TEXT,
  supplier_tax_id TEXT,
  invoice_number TEXT,
  invoice_date TEXT,
  currency TEXT DEFAULT 'EUR',
  subtotal REAL,
  tax_amount REAL,
  total_amount REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  validation_flag TEXT DEFAULT 'ok',
  r2_key TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Πίνακας: κάθε γραμμή = ένα προϊόν/υπηρεσία μέσα σε ένα τιμολόγιο
CREATE TABLE line_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  invoice_id INTEGER NOT NULL,
  description TEXT NOT NULL,
  quantity REAL,
  unit_price REAL,
  line_total REAL NOT NULL,
  confidence TEXT DEFAULT 'high',
  FOREIGN KEY (invoice_id) REFERENCES invoices(id)
);