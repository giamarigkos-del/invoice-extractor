// Integration tests για το invoice-extractor API.
//
// Πώς τρέχει:
//   1. Άνοιξε ένα τερματικό και τρέξε: wrangler dev
//   2. Σε άλλο τερματικό, μέσα στον φάκελο του project: node tests/integration.mjs
//
// ΣΗΜΕΙΩΣΗ: Δεν δοκιμάζει το POST /upload γιατί αυτό θα έκανε πραγματική
// κλήση στο Gemini API (κόστος + χρόνος) κάθε φορά που τρέχουν τα tests.
// Δοκιμάζει τα υπόλοιπα endpoints πάνω σε ό,τι invoices υπάρχουν ήδη στη
// βάση σου (χρειάζεται τουλάχιστον ένα invoice να υπάρχει ήδη).

const BASE_URL = "http://127.0.0.1:8787";

let passed = 0;
let failed = 0;

function assert(condition, message) {
  if (condition) {
    passed++;
    console.log(`  ✓ ${message}`);
  } else {
    failed++;
    console.log(`  ✗ ${message}`);
  }
}

async function testHealth() {
  console.log("\n[/health]");
  const res = await fetch(`${BASE_URL}/health`);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.status === "ok", "status field = 'ok'");
}

async function testGetInvoices() {
  console.log("\n[GET /invoices]");
  const res = await fetch(`${BASE_URL}/invoices`);
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(Array.isArray(data.invoices), "response έχει array 'invoices'");

  if (data.invoices.length === 0) {
    console.log("  ⚠ Δεν υπάρχει κανένα invoice στη βάση — ανέβασε τουλάχιστον ένα πριν ξανατρέξεις τα tests για πλήρη κάλυψη.");
  } else {
    const inv = data.invoices[0];
    assert(typeof inv.id === "number", "invoice έχει αριθμητικό id");
    assert(Array.isArray(inv.line_items), "invoice έχει array 'line_items'");
  }

  return data.invoices;
}

async function testPatchInvoice(invoiceId) {
  console.log(`\n[PATCH /invoices/${invoiceId}]`);

  // Παίρνουμε την τρέχουσα τιμή για να την ξαναγράψουμε ίδια (μη-καταστροφικό test)
  const before = await fetch(`${BASE_URL}/invoices`).then((r) => r.json());
  const original = before.invoices.find((i) => i.id === invoiceId);

  const res = await fetch(`${BASE_URL}/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ supplier_name: original.supplier_name }),
  });
  const data = await res.json();
  assert(res.status === 200, "status 200");
  assert(data.updated === true, "response έχει updated: true");

  // Δοκιμή με άκυρο πεδίο μόνο (πρέπει να απορριφθεί με 400)
  const badRes = await fetch(`${BASE_URL}/invoices/${invoiceId}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ id: 99999, r2_key: "hack" }),
  });
  assert(badRes.status === 400, "άκυρα πεδία (id, r2_key) απορρίπτονται με 400");
}

async function testGetFile(invoiceId) {
  console.log(`\n[GET /invoices/${invoiceId}/file]`);
  const res = await fetch(`${BASE_URL}/invoices/${invoiceId}/file`);
  assert(res.status === 200, "status 200");
  assert(res.headers.get("content-type") !== null, "έχει content-type header");
}

async function testNotFoundCases() {
  console.log("\n[404 handling]");

  const patchRes = await fetch(`${BASE_URL}/invoices/999999`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ supplier_name: "test" }),
  });
  assert(patchRes.status === 404, "PATCH σε ανύπαρκτο id → 404");

  const fileRes = await fetch(`${BASE_URL}/invoices/999999/file`);
  assert(fileRes.status === 404, "GET file σε ανύπαρκτο id → 404");

  const deleteRes = await fetch(`${BASE_URL}/invoices/999999`, { method: "DELETE" });
  assert(deleteRes.status === 404, "DELETE σε ανύπαρκτο id → 404");
}

async function main() {
  console.log("Τρέχουν integration tests πάνω στο:", BASE_URL);

  try {
    await testHealth();
    const invoices = await testGetInvoices();

    if (invoices.length > 0) {
      const firstId = invoices[0].id;
      await testPatchInvoice(firstId);
      await testGetFile(firstId);
    }

    await testNotFoundCases();
  } catch (err) {
    console.error("\n❌ Σφάλμα κατά την εκτέλεση των tests:", err.message);
    console.error("   Βεβαιώσου ότι το 'wrangler dev' τρέχει στο http://127.0.0.1:8787");
    process.exit(1);
  }

  console.log(`\n${"=".repeat(40)}`);
  console.log(`Πέρασαν: ${passed}  |  Απέτυχαν: ${failed}`);
  console.log("=".repeat(40));

  process.exit(failed > 0 ? 1 : 0);
}

main();
