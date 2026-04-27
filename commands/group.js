const { getDB, saveDB } = require("../lib/db");

module.exports = async (sock, from, m, cmd, args, isOwner) => {
    const isGroup = from.endsWith("@g.us");
    if (!isGroup) return;

    const db = getDB();
    if (!db.groups[from]) db.groups[from] = { welcomeEnabled: false, welcomeText: "", goodbyeText: "" };
    
    // Helper: Check if bot is admin
    const groupMetadata = await sock.groupMetadata(from);
    const participants = groupMetadata.participants;
    const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
    const botAdmin = participants.find(p => p.id === botId)?.admin;
    
    // Helper: Check if sender is admin
    const senderJid = m.key.participant || m.key.remoteJid;
    const senderAdmin = participants.find(p => p.id === senderJid)?.admin;
    const hasPermission = isOwner || senderAdmin;

    if (!hasPermission) return;

    // 1. KICK
    if (cmd === "kick") {
        if (!botAdmin) return sock.sendMessage(from, { text: "❌ Bot harus jadi admin untuk kick member." }, { quoted: m });
        let users = m.message.extendedTextMessage?.contextInfo?.mentionedJid || [];
        if (m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
            users.push(m.message.extendedTextMessage.contextInfo.participant);
        }
        if (users.length === 0) return sock.sendMessage(from, { text: "Tag atau reply member yang mau di-kick." }, { quoted: m });
        
        for (let user of users) {
            await sock.groupParticipantsUpdate(from, [user], "remove");
        }
        return sock.sendMessage(from, { text: `✅ Berhasil mengeluarkan ${users.length} member.` }, { quoted: m });
    }

    // 2. OPEN / CLOSE
    if (cmd === "open" || cmd === "close") {
        if (!botAdmin) return sock.sendMessage(from, { text: "❌ Bot harus jadi admin." }, { quoted: m });
        const setting = cmd === "open" ? "not_announcement" : "announcement";
        await sock.groupSettingUpdate(from, setting);
        return sock.sendMessage(from, { text: `✅ Grup berhasil di-${cmd === "open" ? "buka" : "tutup"}.` }, { quoted: m });
    }

    // 3. TAGALL
    if (cmd === "tagall") {
        let message = args.join(" ") || "Halo semuanya!";
        let text = `📢 *TAG ALL*\n\n💬 Pesan: ${message}\n\n`;
        participants.forEach(p => {
            text += `@${p.id.split("@")[0]}\n`;
        });
        return sock.sendMessage(from, { text, mentions: participants.map(p => p.id) }, { quoted: m });
    }

    // 4. HIDETAG
    if (cmd === "hidetag" || cmd === "h") {
        let message = args.join(" ") || "";
        if (!message && m.message.extendedTextMessage?.contextInfo?.quotedMessage) {
            message = m.message.extendedTextMessage.contextInfo.quotedMessage.conversation || m.message.extendedTextMessage.contextInfo.quotedMessage.extendedTextMessage?.text;
        }
        if (!message) return;
        return sock.sendMessage(from, { text: message, mentions: participants.map(p => p.id) });
    }

    // 5. WELCOME ON/OFF
    if (cmd === "welcome") {
        if (!args[0]) return sock.sendMessage(from, { text: "Gunakan: #welcome on/off" }, { quoted: m });
        db.groups[from].welcomeEnabled = args[0] === "on";
        saveDB();
        return sock.sendMessage(from, { text: `✅ Welcome message berhasil di-${args[0]}.` }, { quoted: m });
    }

    // 6. SETWELCOME
    if (cmd === "setwelcome") {
        let text = args.join(" ");
        if (!text) return sock.sendMessage(from, { text: "Gunakan: #setwelcome <teks>\n\nGunakan @user untuk tag member baru dan @group untuk nama grup." }, { quoted: m });
        db.groups[from].welcomeText = text;
        saveDB();
        return sock.sendMessage(from, { text: "✅ Teks welcome berhasil diatur." }, { quoted: m });
    }

    // 7. SETGOODBYE
    if (cmd === "setgoodbye") {
        let text = args.join(" ");
        if (!text) return sock.sendMessage(from, { text: "Gunakan: #setgoodbye <teks>\n\nGunakan @user untuk tag member keluar." }, { quoted: m });
        db.groups[from].goodbyeText = text;
        saveDB();
        return sock.sendMessage(from, { text: "✅ Teks goodbye berhasil diatur." }, { quoted: m });
    }

    // 8. ANTILINK ON/OFF
    if (cmd === "antilink") {
        if (!args[0]) return sock.sendMessage(from, { text: "Gunakan: #antilink on/off" }, { quoted: m });
        db.groups[from].antilink = args[0] === "on";
        saveDB();
        return sock.sendMessage(from, { text: `✅ Anti-Link berhasil di-${args[0]}.` }, { quoted: m });
    }
};