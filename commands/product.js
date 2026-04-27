const config = require("../config");
const { getDB, saveDB } = require("../lib/db");
const fs = require("fs");
const { findProduct, findVariant, formatProductCard, formatMenu, getState, clearState } = require("../lib/product");
const { createOrder, formatInvoice } = require("../lib/order");

module.exports = async (sock, from, m, text, args, isCmd) => {
    const db = getDB();
    const senderJid = m.key.participant || m.key.remoteJid;
    const pushName = m.pushName || "Customer";
    const lowerText = text.toLowerCase().trim();
    const state = getState(senderJid);

    if (lowerText === "menu" || lowerText === "list") {
        return sock.sendMessage(from, { 
            text: formatMenu(db, senderJid.split('@')[0]),
            mentions: [senderJid]
        }, { quoted: m });
    }

    if (lowerText === "batal") {
        clearState(senderJid);
        return sock.sendMessage(from, { text: "❌ Order dibatalkan.\n\nKetik *menu* untuk mulai ulang." }, { quoted: m });
    }

    if (state.step === "pilih_varian" && state.productKey) {
        const product = findProduct(state.productKey);
        if (!product) {
            clearState(senderJid);
            return sock.sendMessage(from, { text: "❌ Produk tidak ditemukan." }, { quoted: m });
        }

        const variant = findVariant(product, lowerText);
        if (!variant) {
            // Cek jika user nanya penjelasan saat di step pilih varian
            if (db.explanations && db.explanations[lowerText]) {
                return sock.sendMessage(from, { text: db.explanations[lowerText] }, { quoted: m });
            }
            return sock.sendMessage(from, { text: "❌ Varian tidak ditemukan.\n\nKetik nama varian yang benar atau *batal* untuk cancel." }, { quoted: m });
        }

        if (variant.stock <= 0) {
            return sock.sendMessage(from, { text: "❌ Stok habis!" }, { quoted: m });
        }

        clearState(senderJid);

        const order = createOrder(senderJid, product, variant);
        const invoice = formatInvoice(order);

        await sock.sendMessage(from, { text: invoice }, { quoted: m });

        const ownerMsg = `📥 *ORDER MASUK*\n\nID: ${order.id}\nProduk: ${order.productName}\nVarian: ${order.variantName}\nTotal: Rp ${order.total.toLocaleString("id-ID")}\nUser: @${senderJid.split('@')[0]}`;
        const ownerJids = config.ownerJids || [];

        for (const ownerJid of ownerJids) {
            await sock.sendMessage(ownerJid, { text: ownerMsg, mentions: [senderJid] });
        }

        return;
    }

    const product = findProduct(lowerText);
    if (product) {
        state.step = "pilih_varian";
        state.productKey = product.name;
        return sock.sendMessage(from, { text: formatProductCard(product) }, { quoted: m });
    }

    // --- AUTO EXPLAIN CHECK ---
    if (db.explanations) {
        // Cari key yang ada di dalam pesan user
        const explainKey = Object.keys(db.explanations).find(key => lowerText.includes(key));
        if (explainKey) {
            return sock.sendMessage(from, { text: db.explanations[explainKey] }, { quoted: m });
        }
    }

    const words = lowerText.split(" ");
    if (words.length >= 2) {
        const firstWord = words[0];
        const restWords = words.slice(1).join(" ");

        const productByFirst = findProduct(firstWord);
        if (productByFirst) {
            const variant = findVariant(productByFirst, restWords);
            if (variant && variant.stock > 0) {
                state.step = "pilih_varian";
                state.productKey = productByFirst.name;
                clearState(senderJid);

                const order = createOrder(senderJid, productByFirst, variant);
                const invoice = formatInvoice(order);

                await sock.sendMessage(from, { text: invoice }, { quoted: m });

                const ownerMsg = `📥 *ORDER MASUK*\n\nID: ${order.id}\nProduk: ${order.productName}\nVarian: ${order.variantName}\nTotal: Rp ${order.total.toLocaleString("id-ID")}\nUser: @${senderJid.split('@')[0]}`;
                const ownerJids = config.ownerJids || [];

                for (const ownerJid of ownerJids) {
                    await sock.sendMessage(ownerJid, { text: ownerMsg, mentions: [senderJid] });
                }

                return;
            }
        }
    }

    if (!isCmd) {
        if (lowerText === "pay") {
            const paymentInfo = db.settings?.paymentInfo || "Belum ada informasi pembayaran. Silakan hubungi Owner.";
            const paymentImage = db.settings?.paymentImagePath;

            if (paymentImage && fs.existsSync(paymentImage)) {
                return sock.sendMessage(from, { 
                    image: fs.readFileSync(paymentImage),
                    caption: `💳 *METODE PEMBAYARAN*\n\n${paymentInfo}\n\n_Silakan kirim bukti bayar setelah transfer._` 
                }, { quoted: m });
            } else {
                return sock.sendMessage(from, { 
                    text: `💳 *METODE PEMBAYARAN*\n\n${paymentInfo}\n\n_Silakan kirim bukti bayar setelah transfer._` 
                }, { quoted: m });
            }
        }

        if (lowerText.includes("cara order")) {
            return sock.sendMessage(from, {
                text: "📦 *CARA ORDER:*\n\n1. Ketik *menu*\n2. Pilih produk (ketik nama)\n3. Pilih varian\n4. Invoice otomatis\n5. Bayar & kirim bukti"
            }, { quoted: m });
        }
    }
};