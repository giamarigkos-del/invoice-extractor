const EXTRACTION_PROMPT = `Είσαι ειδικός στην εξαγωγή δεδομένων από τιμολόγια και αποδείξεις.
Θα σου δώσω ένα αρχείο (PDF ή εικόνα). Ανάλυσέ το και επίστρεψε ΜΟΝΟ ένα JSON object (χωρίς κείμενο πριν ή μετά, χωρίς markdown code fences) με αυτή τη δομή:

{
  "supplier_name": "...",
  "supplier_tax_id": "..." ή null,
  "invoice_number": "..." ή null,
  "invoice_date": "YYYY-MM-DD" ή null,
  "currency": "EUR",
  "subtotal": αριθμός ή null,
  "tax_amount": αριθμός ή null,
  "total_amount": αριθμός,
  "line_items": [
    {
      "description": "...",
      "quantity": αριθμός ή null,
      "unit_price": αριθμός ή null,
      "line_total": αριθμός,
      "confidence": "high" ή "medium" ή "low"
    }
  ],
  "overall_confidence": "high" ή "medium" ή "low"
}

Κανόνες:
- Αν ένα πεδίο δεν είναι ξεκάθαρο ή δεν υπάρχει, βάλε null. Ποτέ μην μαντεύεις.
- Αν δεν υπάρχουν ξεχωριστές γραμμές προϊόντων, βάλε ένα line item με description "Γενικό σύνολο" και line_total ίσο με το total_amount.
- Το νόμισμα προσδιόρισέ το από σύμβολα (€, $) ή κωδικούς. Αν δεν είναι ξεκάθαρο, υπόθεσε EUR.
- Δώσε confidence "low" αν η εικόνα είναι θολή, περικομμένη ή δυσανάγνωστη.
- Το unit_price και το line_total πρέπει να είναι ΣΥΝΕΠΗ μεταξύ τους ως προς το αν περιλαμβάνουν ΦΠΑ ή όχι. Προτίμησε να είναι ΚΑΙ ΤΑ ΔΥΟ χωρίς ΦΠΑ (καθαρές τιμές), ώστε line_total = quantity × unit_price να ισχύει πάντα. Το ΦΠΑ υπολογίζεται ξεχωριστά μόνο στο tax_amount του συνόλου του τιμολογίου.`;

async function callGeminiWithModel(env, base64Data, mimeType, model) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`;

  const body = {
    contents: [
      {
        parts: [
          { inline_data: { mime_type: mimeType, data: base64Data } },
          { text: EXTRACTION_PROMPT },
        ],
      },
    ],
    generationConfig: {
      response_mime_type: "application/json",
    },
  };

  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    const error = new Error(`Gemini API error: ${response.status} ${errorText}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    throw new Error("Gemini did not return any content");
  }

  return JSON.parse(rawText);
}

async function callGemini(env, base64Data, mimeType) {
  try {
    return await callGeminiWithModel(env, base64Data, mimeType, "gemini-3.8-flash");
  } catch (err) {
    if (err.status === 503) {
      return await callGeminiWithModel(env, base64Data, mimeType, "gemini-3.6-flash");
    }
    throw err;
  }
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function handleUpload(request, env) {
  const formData = await request.formData();
  const file = formData.get("file");

  if (!file || typeof file === "string") {
    return new Response(JSON.stringify({ error: "Δεν βρέθηκε αρχείο" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_SIZE_BYTES) {
    return new Response(
      JSON.stringify({ error: "Το αρχείο είναι πολύ μεγάλο (όριο 10MB)" }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  const workspaceId = "default"; // προσωρινό, θα γίνει δυναμικό αργότερα
  const arrayBuffer = await file.arrayBuffer();

  // 1. Αποθήκευση πρωτότυπου αρχείου στο R2
  const r2Key = `${workspaceId}/${Date.now()}-${file.name}`;
  await env.FILES.put(r2Key, arrayBuffer, {
    httpMetadata: { contentType: file.type },
  });

  // 2. Εξαγωγή δεδομένων μέσω Gemini
  const base64Data = arrayBufferToBase64(arrayBuffer);
  let extracted;
  try {
    extracted = await callGemini(env, base64Data, file.type);
  } catch (err) {
    return new Response(
      JSON.stringify({ error: "Αποτυχία εξαγωγής", details: err.message }),
      { status: 500, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  // 3. Έλεγχος μαθηματικών
  let validationFlag = "ok";
  if (extracted.subtotal != null && extracted.tax_amount != null) {
    const expectedTotal = extracted.subtotal + extracted.tax_amount;
    if (Math.abs(expectedTotal - extracted.total_amount) > 0.05) {
      validationFlag = "math_mismatch";
    }
  }

  // 4. Έλεγχος διπλότυπου (μόνο invoice_number + total_amount, όχι supplier_name γιατί το Gemini
  // δεν είναι πάντα συνεπές στην εξαγωγή ονόματος προμηθευτή π.χ. "Μ.Ι.Κ.Ε." vs "M I K E")
  const existing = await env.DB.prepare(
    `SELECT id FROM invoices WHERE workspace_id = ? AND invoice_number = ? AND total_amount = ?`
  )
    .bind(workspaceId, extracted.invoice_number, extracted.total_amount)
    .first();

  if (existing) {
    validationFlag = "possible_duplicate";
  }

  // 5. Αποθήκευση invoice στη D1
  const insertInvoice = await env.DB.prepare(
    `INSERT INTO invoices (workspace_id, supplier_name, supplier_tax_id, invoice_number, invoice_date, currency, subtotal, tax_amount, total_amount, status, validation_flag, r2_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?)`
  )
    .bind(
      workspaceId,
      extracted.supplier_name,
      extracted.supplier_tax_id,
      extracted.invoice_number,
      extracted.invoice_date,
      extracted.currency || "EUR",
      extracted.subtotal,
      extracted.tax_amount,
      extracted.total_amount,
      validationFlag,
      r2Key
    )
    .run();

  const invoiceId = insertInvoice.meta.last_row_id;

  // 6. Αποθήκευση line items
  for (const item of extracted.line_items || []) {
    await env.DB.prepare(
      `INSERT INTO line_items (invoice_id, description, quantity, unit_price, line_total, confidence)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
      .bind(invoiceId, item.description, item.quantity, item.unit_price, item.line_total, item.confidence || "high")
      .run();
  }

  return new Response(
    JSON.stringify({
      invoice_id: invoiceId,
      validation_flag: validationFlag,
      extracted,
    }),
    { headers: { "Content-Type": "application/json; charset=utf-8" } }
  );
}

async function handleGetInvoices(request, env) {
  const workspaceId = "default"; // προσωρινό, θα γίνει δυναμικό αργότερα

  const query = `
    SELECT
      i.id, i.workspace_id, i.supplier_name, i.supplier_tax_id,
      i.invoice_number, i.invoice_date, i.currency,
      i.subtotal, i.tax_amount, i.total_amount,
      i.status, i.validation_flag, i.r2_key, i.created_at,
      li.id AS line_id, li.description, li.quantity,
      li.unit_price, li.line_total, li.confidence
    FROM invoices i
    LEFT JOIN line_items li ON li.invoice_id = i.id
    WHERE i.workspace_id = ?
    ORDER BY i.created_at DESC, li.id ASC
  `;

  const { results } = await env.DB.prepare(query).bind(workspaceId).all();

  // Ομαδοποίηση: κάθε invoice_id -> ένα object με nested line_items array
  const invoicesMap = new Map();

  for (const row of results) {
    if (!invoicesMap.has(row.id)) {
      invoicesMap.set(row.id, {
        id: row.id,
        workspace_id: row.workspace_id,
        supplier_name: row.supplier_name,
        supplier_tax_id: row.supplier_tax_id,
        invoice_number: row.invoice_number,
        invoice_date: row.invoice_date,
        currency: row.currency,
        subtotal: row.subtotal,
        tax_amount: row.tax_amount,
        total_amount: row.total_amount,
        status: row.status,
        validation_flag: row.validation_flag,
        r2_key: row.r2_key,
        created_at: row.created_at,
        line_items: [],
      });
    }

    // Αν υπάρχει line item (LEFT JOIN μπορεί να δώσει NULL αν το invoice δεν έχει items)
    if (row.line_id !== null) {
      invoicesMap.get(row.id).line_items.push({
        id: row.line_id,
        description: row.description,
        quantity: row.quantity,
        unit_price: row.unit_price,
        line_total: row.line_total,
        confidence: row.confidence,
      });
    }
  }

  const invoices = Array.from(invoicesMap.values());

  return new Response(JSON.stringify({ invoices }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleDeleteInvoice(invoiceId, env) {
  // Πρώτα διαγράφουμε τα line items (το D1/SQLite δεν επιβάλλει foreign key
  // constraints αυτόματα, άρα πρέπει να το κάνουμε ρητά εμείς)
  await env.DB.prepare(`DELETE FROM line_items WHERE invoice_id = ?`)
    .bind(invoiceId)
    .run();

  const result = await env.DB.prepare(`DELETE FROM invoices WHERE id = ?`)
    .bind(invoiceId)
    .run();

  if (result.meta.changes === 0) {
    return new Response(JSON.stringify({ error: "Το τιμολόγιο δεν βρέθηκε" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  return new Response(JSON.stringify({ deleted: true, invoice_id: invoiceId }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

const PATCHABLE_FIELDS = [
  "supplier_name",
  "supplier_tax_id",
  "invoice_number",
  "invoice_date",
  "currency",
  "subtotal",
  "tax_amount",
  "total_amount",
  "validation_flag",
  "status",
];

async function handlePatchInvoice(invoiceId, request, env) {
  let body;
  try {
    body = await request.json();
  } catch (err) {
    return new Response(JSON.stringify({ error: "Μη έγκυρο JSON σώμα αιτήματος" }), {
      status: 400,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  // Κρατάμε μόνο τα πεδία που επιτρέπεται να αλλάξουν, αγνοούμε οτιδήποτε άλλο
  // στάλθηκε (π.χ. id, r2_key, created_at δεν πρέπει να αλλάζουν από εδώ)
  const fieldsToUpdate = Object.keys(body).filter((key) => PATCHABLE_FIELDS.includes(key));

  if (fieldsToUpdate.length === 0) {
    return new Response(
      JSON.stringify({ error: "Δεν στάλθηκε κανένα έγκυρο πεδίο προς ενημέρωση" }),
      { status: 400, headers: { "Content-Type": "application/json; charset=utf-8" } }
    );
  }

  const setClause = fieldsToUpdate.map((field) => `${field} = ?`).join(", ");
  const values = fieldsToUpdate.map((field) => body[field]);

  const result = await env.DB.prepare(
    `UPDATE invoices SET ${setClause} WHERE id = ?`
  )
    .bind(...values, invoiceId)
    .run();

  if (result.meta.changes === 0) {
    return new Response(JSON.stringify({ error: "Το τιμολόγιο δεν βρέθηκε" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const updated = await env.DB.prepare(`SELECT * FROM invoices WHERE id = ?`)
    .bind(invoiceId)
    .first();

  return new Response(JSON.stringify({ updated: true, invoice: updated }), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

async function handleGetInvoiceFile(invoiceId, env) {
  const invoice = await env.DB.prepare(`SELECT r2_key FROM invoices WHERE id = ?`)
    .bind(invoiceId)
    .first();

  if (!invoice) {
    return new Response(JSON.stringify({ error: "Το τιμολόγιο δεν βρέθηκε" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const object = await env.FILES.get(invoice.r2_key);

  if (!object) {
    return new Response(JSON.stringify({ error: "Το αρχείο δεν βρέθηκε στο R2" }), {
      status: 404,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    });
  }

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("Content-Disposition", "inline");

  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, PATCH, DELETE, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "invoice-extractor" }),
        { headers: { "Content-Type": "application/json; charset=utf-8" } }
      );
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      const response = await handleUpload(request, env);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    if (url.pathname === "/invoices" && request.method === "GET") {
      const response = await handleGetInvoices(request, env);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    const invoiceIdMatch = url.pathname.match(/^\/invoices\/(\d+)$/);
    if (invoiceIdMatch && request.method === "DELETE") {
      const invoiceId = parseInt(invoiceIdMatch[1], 10);
      const response = await handleDeleteInvoice(invoiceId, env);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    if (invoiceIdMatch && request.method === "PATCH") {
      const invoiceId = parseInt(invoiceIdMatch[1], 10);
      const response = await handlePatchInvoice(invoiceId, request, env);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    const fileMatch = url.pathname.match(/^\/invoices\/(\d+)\/file$/);
    if (fileMatch && request.method === "GET") {
      const invoiceId = parseInt(fileMatch[1], 10);
      const response = await handleGetInvoiceFile(invoiceId, env);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    return new Response("Not found", { status: 404 });
  },
};