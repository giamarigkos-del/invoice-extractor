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
- Δώσε confidence "low" αν η εικόνα είναι θολή, περικομμένη ή δυσανάγνωστη.`;

async function callGemini(env, base64Data, mimeType) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.8-flash:generateContent?key=${env.GEMINI_API_KEY}`;

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
    throw new Error(`Gemini API error: ${response.status} ${errorText}`);
  }

  const data = await response.json();
  const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;

  if (!rawText) {
    throw new Error("Gemini did not return any content");
  }

  return JSON.parse(rawText);
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
      headers: { "Content-Type": "application/json" },
    });
  }

  const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB
  if (file.size > MAX_SIZE_BYTES) {
    return new Response(
      JSON.stringify({ error: "Το αρχείο είναι πολύ μεγάλο (όριο 10MB)" }),
      { status: 400, headers: { "Content-Type": "application/json" } }
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
      { status: 500, headers: { "Content-Type": "application/json" } }
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

  // 4. Έλεγχος διπλότυπου
  const existing = await env.DB.prepare(
    `SELECT id FROM invoices WHERE workspace_id = ? AND supplier_name = ? AND invoice_number = ? AND total_amount = ?`
  )
    .bind(workspaceId, extracted.supplier_name, extracted.invoice_number, extracted.total_amount)
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
    { headers: { "Content-Type": "application/json" } }
  );
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // CORS, χρήσιμο για τοπικά tests από απλό HTML αρχείο
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: {
          "Access-Control-Allow-Origin": "*",
          "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
          "Access-Control-Allow-Headers": "Content-Type",
        },
      });
    }

    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "invoice-extractor" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    if (url.pathname === "/upload" && request.method === "POST") {
      const response = await handleUpload(request, env);
      response.headers.set("Access-Control-Allow-Origin", "*");
      return response;
    }

    return new Response("Not found", { status: 404 });
  },
};