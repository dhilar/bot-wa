const { getDB, saveDB } = require("../lib/db");

module.exports = async (sock, from, m, cmd, args, isOwner) => {
    if (!isOwner) return;

    const db = getDB();

    // 1. BROADCAST GROUP (BC)
    if (cmd === "bc" || cmd === "broadcast") {
        let text = args.join(" ");
        if (!text && m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
            text = m.message.extendedTextMessage.contextInfo.quotedMessage.conversation || m.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text;
        }
        if (!text) return sock.sendMessage(from, { text: "Masukkan teks broadcast atau reply pesan." }, { quoted: m });

        const groups = await sock.groupFetchAllParticipating();
        const groupJids = Object.keys(groups);

        await sock.sendMessage(from, { text: `🚀 Mengirim broadcast ke ${groupJids.length} grup...` }, { quoted: m });

        let success = 0;
        for (let jid of groupJids) {
            try {
                await sock.sendMessage(jid, { 
                    text: `📢 *BROADCAST*\n\n${text}\n\n_Sent by Owner_` 
                });
                success++;
            } catch (e) {
                console.error(`Gagal kirim BC ke ${jid}:`, e.message);
            }
        }

        return sock.sendMessage(from, { text: `✅ Broadcast selesai!\nBerhasil: ${success}\nGagal: ${groupJids.length - success}` }, { quoted: m });
    }

    // 2. BROADCAST USER (BCUSER)
    if (cmd === "bcuser") {
        let text = args.join(" ");
        if (!text && m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
            text = m.message.extendedTextMessage.contextInfo.quotedMessage.conversation || m.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text;
        }
        if (!text) return sock.sendMessage(from, { text: "Masukkan teks broadcast atau reply pesan." }, { quoted: m });

        const userJids = db.users || [];
        if (userJids.length === 0) return sock.sendMessage(from, { text: "Belum ada user yang terdaftar." }, { quoted: m });

        await sock.sendMessage(from, { text: `🚀 Mengirim broadcast ke ${userJids.length} user...` }, { quoted: m });

        let success = 0;
        for (let jid of userJids) {
            try {
                await sock.sendMessage(jid, { 
                    text: `📢 *INFO STORE*\n\n${text}\n\n_Sent by Owner_` 
                });
                success++;
            } catch (e) {
                console.error(`Gagal kirim BC ke user ${jid}:`, e.message);
            }
        }

        return sock.sendMessage(from, { text: `✅ Broadcast User selesai!\nBerhasil: ${success}\nGagal: ${userJids.length - success}` }, { quoted: m });
    }

    // 3. SET AUTO MESSAGE GROUP
    if (cmd === "setautomsg") {
        const text = args.join(" ");
        if (!text.includes("|")) return sock.sendMessage(from, { text: "Gunakan: #setautomsg interval_menit|pesan\n\nContoh: #setautomsg 60|Jangan lupa order ya!" }, { quoted: m });

        const [interval, ...msgParts] = text.split("|");
        const msg = msgParts.join("|");

        if (!db.settings) db.settings = {};
        db.settings.autoMsgGroup = {
            enabled: true,
            interval: parseInt(interval),
            text: msg,
            lastSent: 0
        };
        saveDB();

        return sock.sendMessage(from, { text: `✅ Auto Message Group diaktifkan setiap ${interval} menit.` }, { quoted: m });
    }

    // 4. STOP AUTO MESSAGE GROUP
    if (cmd === "stopautomsg") {
        if (!db.settings?.autoMsgGroup) return sock.sendMessage(from, { text: "Auto message belum diatur." }, { quoted: m });
        db.settings.autoMsgGroup.enabled = false;
        saveDB();
        return sock.sendMessage(from, { text: "✅ Auto Message Group dimatikan." }, { quoted: m });
    }
};