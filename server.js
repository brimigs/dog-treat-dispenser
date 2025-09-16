import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ type: "*/*" })); // Helius sends JSON

const PUBKEY = process.env.PUBLIC_KEY_TO_WATCH;
const VSH_URL = process.env.VSH_TRIGGER_URL;
const SECRET = process.env.WEBHOOK_SECRET;

let lastTreatAt = 0;
const MIN_TREAT_INTERVAL_MS = 10_000; // guardrail: 1 treat / 10s

// Simple shared-secret check (set this header in Helius webhook settings)
function verifyAuth(req) {
  const header = req.headers["x-webhook-secret"];
  return header && SECRET && header === SECRET;
}

function includesNativeTransferToMe(heliusBody) {
  try {
    // Helius webhooks include a list of "transactions" with parsed transfers.
    // We'll scan for native SOL (lamports) transferred to our wallet.
    const txs = heliusBody?.events || heliusBody?.transactions || [];
    // Try both shapes (depends on webhook type)
    const checkOneTx = (tx) => {
      // Preferred: native transfers
      const native = tx?.nativeTransfers || tx?.solTransfers || [];
      if (Array.isArray(native)) {
        return native.some(
          (t) =>
            t?.toUserAccount?.toString() === PUBKEY &&
            (t?.amount || t?.lamports) > 0
        );
      }
      return false;
    };
    return txs.some(checkOneTx);
  } catch {
    return false;
  }
}

async function triggerTreat() {
  const now = Date.now();
  if (now - lastTreatAt < MIN_TREAT_INTERVAL_MS)
    return { skipped: true, reason: "debounced" };
  lastTreatAt = now;

  const res = await fetch(VSH_URL, { method: "GET" }); // or POST if required
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`VSH trigger failed: ${res.status} ${text}`);
  }
  return { ok: true };
}

app.post("/helius", async (req, res) => {
  try {
    if (!verifyAuth(req))
      return res.status(401).json({ error: "unauthorized" });

    if (includesNativeTransferToMe(req.body)) {
      await triggerTreat();
      return res.json({ received: true, action: "treat" });
    }
    return res.json({ received: true, action: "ignored" });
  } catch (e) {
    console.error(e);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 8080, () => {
  console.log(`listening on ${process.env.PORT || 8080}`);
});
