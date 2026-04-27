const { getDB, saveDB } = require("../lib/db");
const { completeOrder, cancelOrder, formatInvoice } = require("../lib/order");
const { downloadMediaMessage } = require("@whiskeysockets/baileys");
const fs = require("fs");
const path = require("path");

function setOrderStatus(orderId, status) {
    const db = getDB();
    const order = db.orders.find(o => o.id === orderId);
    if (!order) return { success: false, message: `❌ Order ${orderId} tidak ditemukan.` };

    const oldStatus = order.status;
    order.status = status;
    saveDB();
    return { success: true, message: `✅ Status INV-${orderId.split('-')[1]} berhasil diubah menjadi ${status}`, order };
}

function findLastPendingOrder(senderJid) {
    const db = getDB();
    const userOrders = db.orders.filter(o => o.user === senderJid && o.status === "pending");
    if (userOrders.length === 0) return null;
    return userOrders.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
}

module.exports = async (sock, from, m, cmd, args, isOwner) => {
    if (!isOwner) return;

    const db = getDB();

    if (cmd === "p") {
        let orderId = null;
        let note = args.slice(1).join(" ");

        if (args[0]) {
            orderId = `INV-${args[0]}`;
        } else {
            // Cek jika ada last pending order yang dicatat di db
            const lastIdFromDb = db.lastOrders?.[from];
            if (lastIdFromDb) {
                orderId = lastIdFromDb;
            } else {
                // Fallback ke pencarian manual
                const lastOrder = findLastPendingOrder(from);
                if (lastOrder) {
                    orderId = lastOrder.id;
                }
            }
        }

        if (!orderId) return sock.sendMessage(from, { text: "Format: #p <id>\n\nAtau ada order pending terakhir untuk diproses." }, { quoted: m });

        const order = completeOrder(orderId);
        if (!order) return sock.sendMessage(from, { text: "❌ Order tidak ditemukan atau sudah diproses." }, { quoted: m });

        const msg = `✅ *PESANAN SELESAI*\n\nID: ${order.id}\nProduk: ${order.productName}\nVarian: ${order.variantName}\nTotal: Rp ${order.total.toLocaleString("id-ID")}\n\n${note ? `📝 *Catatan/Akun*:\n${note}` : 'Terima kasih sudah order!'}`;

        await sock.sendMessage(order.user, { text: msg });
        return sock.sendMessage(from, { text: `✅ Order ${order.id} berhasil diselesaikan!` }, { quoted: m });
    }

    if (cmd === "done") {
        if (!args[0]) return sock.sendMessage(from, { text: "Format: #done <id>" }, { quoted: m });
        const result = setOrderStatus(`INV-${args[0]}`, "success");
        return sock.sendMessage(from, { text: result.message }, { quoted: m });
    }

    if (cmd === "pending") {
        if (!args[0]) return sock.sendMessage(from, { text: "Format: #pending <id>" }, { quoted: m });
        const result = setOrderStatus(`INV-${args[0]}`, "pending");
        return sock.sendMessage(from, { text: result.message }, { quoted: m });
    }

    if (cmd === "cancel") {
        if (!args[0]) return sock.sendMessage(from, { text: "Format: #cancel <id>" }, { quoted: m });
        const result = cancelOrder(`INV-${args[0]}`, "Dibatalkan oleh Owner");
        if (!result) return sock.sendMessage(from, { text: `❌ Gagal membatalkan order INV-${args[0]}.` }, { quoted: m });
        return sock.sendMessage(from, { text: `✅ Status INV-${args[0]} berhasil diubah menjadi cancel` }, { quoted: m });
    }

    if (cmd === "orders") {
        const pending = db.orders.filter(o => o.status === "pending");
        if (pending.length === 0) return sock.sendMessage(from, { text: "📭 Tidak ada order pending." }, { quoted: m });

        let text = "📋 *DAFTAR ORDER PENDING*\n\n";
        pending.forEach(o => {
            text += `• ${o.id} | ${o.productName} | @${o.user.split('@')[0]}\n`;
        });
        return sock.sendMessage(from, { text, mentions: pending.map(o => o.user) }, { quoted: m });
    }

    if (cmd === "c") {
        if (!args[0]) return sock.sendMessage(from, { text: "Format: #c <id>" }, { quoted: m });
        const result = cancelOrder(`INV-${args[0]}`, "Dibatalkan oleh Owner");
        if (!result) return sock.sendMessage(from, { text: `❌ Gagal membatalkan order INV-${args[0]}.` }, { quoted: m });
        return sock.sendMessage(from, { text: `✅ Order INV-${args[0]} dibatalkan.` }, { quoted: m });
    }

    // --- CUSTOM EXPLAIN COMMANDS ---
    
    // #setexplain netflix|ini penjelasan netflix
    if (cmd === "setexplain" || cmd === "setdesc") {
        const text = args.join(" ");
        if (!text.includes("|")) return sock.sendMessage(from, { text: "Gunakan: #setexplain nama_produk|teks penjelasan" }, { quoted: m });
        
        const [key, ...descParts] = text.split("|");
        const desc = descParts.join("|");
        
        if (!db.explanations) db.explanations = {};
        db.explanations[key.toLowerCase().trim()] = desc.trim();
        saveDB();
        
        return sock.sendMessage(from, { text: `✅ Penjelasan untuk *${key.trim()}* berhasil disimpan.` }, { quoted: m });
    }

    // #delexplain netflix
    if (cmd === "delexplain" || cmd === "deldesc") {
        const key = args.join(" ").toLowerCase().trim();
        if (!key || !db.explanations?.[key]) return sock.sendMessage(from, { text: "Penjelasan tidak ditemukan." }, { quoted: m });
        
        delete db.explanations[key];
        saveDB();
        return sock.sendMessage(from, { text: `✅ Penjelasan untuk *${key}* berhasil dihapus.` }, { quoted: m });
    }

    // #listexplain
    if (cmd === "listexplain") {
        if (!db.explanations || Object.keys(db.explanations).length === 0) return sock.sendMessage(from, { text: "Belum ada penjelasan custom." }, { quoted: m });
        
        let text = "📋 *DAFTAR PENJELASAN CUSTOM*\n\n";
        for (let key in db.explanations) {
            text += `• ${key}\n`;
        }
        return sock.sendMessage(from, { text }, { quoted: m });
    }

    // #setpayment DANA: 08123456789 | QRIS: [link]
    if (cmd === "setpayment") {
        const text = args.join(" ");
        const quoted = m.message.extendedTextMessage?.contextInfo?.quotedMessage;
        const isImage = quoted?.imageMessage;

        if (!text && !isImage) {
            return sock.sendMessage(from, { text: "Gunakan: #setpayment <teks instruksi>\nAtau reply FOTO QRIS dengan caption #setpayment <teks>" }, { quoted: m });
        }
        
        if (!db.settings) db.settings = {};
        db.settings.paymentInfo = text || db.settings.paymentInfo || "";

        if (isImage) {
            try {
                const buffer = await downloadMediaMessage(
                    { message: quoted },
                    'buffer',
                    {},
                    { logger: console, reuploadRequest: sock.updateMediaMessage }
                );
                const fileName = `qris_${Date.now()}.jpg`;
                const filePath = path.join("media", fileName);
                fs.writeFileSync(filePath, buffer);
                db.settings.paymentImage = filePath;
                
                // Hapus foto lama jika ada
                if (db.settings.paymentImagePath && fs.existsSync(db.settings.paymentImagePath) && db.settings.paymentImagePath !== filePath) {
                    fs.unlinkSync(db.settings.paymentImagePath);
                }
                db.settings.paymentImagePath = filePath;
            } catch (e) {
                console.error("Gagal download QRIS:", e);
                return sock.sendMessage(from, { text: "❌ Gagal menyimpan foto QRIS." }, { quoted: m });
            }
        }

        saveDB();
        const msg = isImage ? "✅ Instruksi pembayaran & Foto QRIS berhasil disimpan." : "✅ Instruksi pembayaran berhasil diatur.";
        return sock.sendMessage(from, { text: msg }, { quoted: m });
    }
};