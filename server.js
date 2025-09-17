import "dotenv/config";
import express from "express";
import fetch from "node-fetch";

const app = express();
app.use(express.json({ type: "*/*" })); // Helius sends JSON

const PUBKEY = process.env.PUBLIC_KEY_TO_WATCH;
const VSH_URL = process.env.VSH_TRIGGER_URL;
const SECRET = process.env.WEBHOOK_SECRET;

let lastTreatAt = 0;
const MIN_TREAT_INTERVAL_MS = 10_000;

function verifyAuth(req) {
  // Skip auth check
  console.log("Auth check disabled - webhook accepted");
  return true;
}

function includesNativeTransferToMe(heliusBody) {
  try {
    // Helius sends an array of transactions directly
    const txs = Array.isArray(heliusBody)
      ? heliusBody
      : heliusBody?.events || heliusBody?.transactions || [];

    const checkOneTx = (tx) => {
      // Check native transfers
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
  } catch (e) {
    console.error("Error checking transfers:", e);
    return false;
  }
}

async function triggerTreat() {
  const now = Date.now();
  if (now - lastTreatAt < MIN_TREAT_INTERVAL_MS) {
    console.log("Treat skipped - debounce (too soon since last treat)");
    return { skipped: true, reason: "debounced" };
  }
  lastTreatAt = now;

  console.log("Calling VSH trigger URL:", VSH_URL);
  try {
    const res = await fetch(VSH_URL, { method: "GET" });
    const text = await res.text();
    console.log("VSH response status:", res.status);
    console.log("VSH response body:", text);

    if (!res.ok) {
      throw new Error(`VSH trigger failed: ${res.status} ${text}`);
    }

    // Try to parse as JSON if possible
    try {
      const json = JSON.parse(text);
      console.log("VSH trigger successful:", json);
      return { ok: true, response: json };
    } catch {
      console.log("VSH trigger returned non-JSON:", text);
      return { ok: true, response: text };
    }
  } catch (error) {
    console.error("Error calling VSH:", error);
    throw error;
  }
}

app.post("/helius", async (req, res) => {
  console.log("=== Webhook received ===");
  console.log("Headers:", JSON.stringify(req.headers, null, 2));
  console.log("Body:", JSON.stringify(req.body, null, 2));

  try {
    if (!verifyAuth(req)) {
      console.log(
        "Auth failed - expected:",
        SECRET,
        "got:",
        req.headers["authorization"]
      );
      return res.status(401).json({ error: "unauthorized" });
    }

    if (includesNativeTransferToMe(req.body)) {
      console.log("Native transfer detected! Triggering treat...");
      const result = await triggerTreat();
      console.log("Treat trigger result:", result);
      return res.json({ received: true, action: "treat", result });
    }
    console.log("No matching transfer found");
    return res.json({ received: true, action: "ignored" });
  } catch (e) {
    console.error("Error processing webhook:", e);
    return res.status(500).json({ error: e.message });
  }
});

app.get("/", (_, res) => res.send("OK"));

app.listen(process.env.PORT || 8080, () => {
  console.log(`listening on ${process.env.PORT || 8080}`);
});
