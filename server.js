import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID; // Your Telegram numeric ID
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN) {
  console.error("Missing BOT_TOKEN");
  process.exit(1);
}

const ITEMS = {
  watermark: { title: "Custom Watermark", description: "Custom edit watermark", stars: 50 },
  outro: { title: "Outro Edit (~16 MB)", description: "Finished video outro edit", stars: 120 },
};

const seenCharges = new Set();

async function tgApi(method, body) {
  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function sendFileToBuyer(buyerChatId, fileBuffer, fileName, caption = "Your finished edit material is ready!") {
  const formData = new FormData();
  formData.append("chat_id", String(buyerChatId));
  formData.append("caption", caption);
  formData.append("document", new Blob([fileBuffer]), fileName);

  const res = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendDocument`, {
    method: "POST",
    body: formData,
  });
  return res.json();
}

// CLI helper mode: `node server.js send <buyerId> <filePath> [caption]`
if (process.argv[2] === "send") {
  const [, , , buyerId, filePath, ...captionParts] = process.argv;
  if (!buyerId || !filePath) {
    console.error("Usage: node server.js send <buyerId> <filePath> [caption]");
    process.exit(1);
  }
  const buf = fs.readFileSync(filePath);
  const out = await sendFileToBuyer(buyerId, buf, path.basename(filePath), captionParts.join(" ") || undefined);
  console.log(out.ok ? `Sent! file_id: ${out.result.document.file_id}` : out);
  process.exit(out.ok ? 0 : 1);
}

http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    return res.end();
  }

  let raw = "";
  for await (const chunk of req) raw += chunk;

  // Create Telegram Stars invoice link
  if (req.method === "POST" && req.url === "/api/create-invoice") {
    const { itemKey, buyerId, notes } = JSON.parse(raw || "{}");
    const item = ITEMS[itemKey];
    if (!item || !buyerId) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: "Invalid itemKey or buyerId" }));
    }

    const payload = JSON.stringify({ u: buyerId, k: itemKey, n: (notes || "").slice(0, 45) });
    const tgRes = await tgApi("createInvoiceLink", {
      title: item.title,
      description: item.description,
      payload,
      provider_token: "",
      currency: "XTR",
      prices: [{ label: item.title, amount: item.stars }],
    });

    if (!tgRes.ok) {
      res.writeHead(500, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ error: tgRes.description }));
    }

    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ invoiceLink: tgRes.result }));
  }

  // Log crypto order & alert admin in Telegram
  if (req.method === "POST" && req.url === "/api/crypto-order") {
    const { buyerId, buyerName, itemKey, notes, txRef } = JSON.parse(raw || "{}");
    if (ADMIN_CHAT_ID) {
      await tgApi("sendMessage", {
        chat_id: ADMIN_CHAT_ID,
        text:
          `CRYPTO ORDER (Verify payment before sending)\n` +
          `Buyer: ${buyerName} | ID: ${buyerId}\n` +
          `Item: ${itemKey}\n` +
          `Tx/Note: ${txRef || "none"}\n` +
          `Details: ${notes}`,
      });
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    return res.end(JSON.stringify({ ok: true }));
  }

  // Telegram Bot Webhook
  if (req.method === "POST" && req.url === "/webhook") {
    const update = JSON.parse(raw || "{}");

    if (update.pre_checkout_query) {
      await tgApi("answerPreCheckoutQuery", {
        pre_checkout_query_id: update.pre_checkout_query.id,
        ok: true,
      });
      res.writeHead(200);
      return res.end("ok");
    }

    const payment = update.message?.successful_payment;
    if (payment && !seenCharges.has(payment.telegram_payment_charge_id)) {
      seenCharges.add(payment.telegram_payment_charge_id);
      const buyer = update.message.from;
      if (ADMIN_CHAT_ID) {
        await tgApi("sendMessage", {
          chat_id: ADMIN_CHAT_ID,
          text:
            `PAID WITH STARS!\n` +
            `Buyer: ${buyer.first_name} (@${buyer.username || "none"}) | ID: ${buyer.id}\n` +
            `Paid: ${payment.total_amount} ${payment.currency}\n` +
            `Payload: ${payment.invoice_payload}`,
        });
      }
    }

    // Quick delivery: in your admin chat, reply to an order message with a document/video
    const msg = update.message;
    if (
      msg &&
      String(msg.chat?.id) === String(ADMIN_CHAT_ID) &&
      msg.reply_to_message?.text &&
      (msg.document || msg.video)
    ) {
      const idMatch = msg.reply_to_message.text.match(/ID:\s*(\d+)/);
      const fileObj = msg.document || msg.video;
      if (idMatch && fileObj) {
        const targetBuyerId = idMatch[1];
        await tgApi("sendDocument", {
          chat_id: targetBuyerId,
          document: fileObj.file_id,
          caption: msg.caption || "Your finished edit material is ready!",
        });
        await tgApi("sendMessage", {
          chat_id: ADMIN_CHAT_ID,
          text: `Delivered to buyer ID ${targetBuyerId}!`,
        });
      }
    }

    res.writeHead(200);
    return res.end("ok");
  }

  res.writeHead(404);
  res.end();
}).listen(PORT, () => console.log(`Server running on :${PORT}`));
