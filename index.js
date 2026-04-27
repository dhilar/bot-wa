const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason
} = require("@whiskeysockets/baileys");

const qrcode = require("qrcode-terminal");
const config = require("./config");

const { loadDB, saveDB, getDB } = require("./lib/db");
const { cancelOrder } = require("./lib/order");
const {
    cleanText,
    parseMessageText,
    isOwner
} = require("./lib/utils");

// Load DB sekali
loadDB(config.dbFile);

async function startBot() {
    const { state, saveCreds } = await useMultiFileAuthState(config.sessionPath);
    const { version } = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth: state,
        browser: [config.botName, "Chrome", "1.0.0"]
    });

    sock.ev.on("creds.update", saveCreds);

    // =========================
    // 🔁 SCHEDULER (1 MENIT)
    // =========================
    setInterval(async () => {
        const db = getDB();
        if (!db) return;

        if (!db.orders) db.orders = [];
        if (!db.settings) db.settings = {};

        const now = new Date();

        // AUTO CANCEL ORDER
        for (const order of db.orders) {
            if (order.status === "pending" && new Date(order.expiresAt) < now) {
                cancelOrder(order.id, "Expired (30 minutes)");
                console.log(`[AUTO CANCEL] ${order.id}`);
            }
        }

        // AUTO STATUS
        const s = db.settings?.autoStatus || {};

        if (
            s.enabled &&
            s.text &&
            Date.now() - (s.lastSent || 0) > s.interval * 60000
        ) {
            try {
                const groups = await sock.groupFetchAllParticipating();
                const participants = new Set();

                for (const g of Object.values(groups)) {
                    for (const p of g.participants) {
                        participants.add(p.id);
                    }
                }

                await sock.sendMessage(
                    "status@broadcast",
                    { text: s.text },
                    { statusJidList: Array.from(participants) }
                );

                db.settings.autoStatus.lastSent = Date.now();
                saveDB();

                console.log("✅ AUTO STATUS SENT");
            } catch (e) {
                console.error("Auto Status Error:", e.message);
            }
        }

        // AUTO MESSAGE GROUP
        const amg = db.settings?.autoMsgGroup || {};
        if (
            amg.enabled &&
            amg.text &&
            Date.now() - (amg.lastSent || 0) > amg.interval * 60000
        ) {
            try {
                const groups = await sock.groupFetchAllParticipating();
                const groupJids = Object.keys(groups);

                for (let jid of groupJids) {
                    await sock.sendMessage(jid, { text: amg.text });
                }

                db.settings.autoMsgGroup.lastSent = Date.now();
                saveDB();
                console.log("✅ AUTO MESSAGE GROUP SENT");
            } catch (e) {
                console.error("Auto Msg Group Error:", e.message);
            }
        }
    }, 60000);

    // =========================
    // 📩 MESSAGE HANDLER
    // =========================
    sock.ev.on("group-participants.update", async (anu) => {
        const db = getDB();
        const from = anu.id;
        const g = db.groups[from] || {};
        if (!g.welcomeEnabled) return;

        for (let num of anu.participants) {
            let userName = `@${num.split("@")[0]}`;
            if (anu.action === "add") {
                let msg = g.welcomeText || "Selamat datang @user di grup @group!";
                msg = msg.replace("@user", userName).replace("@group", (await sock.groupMetadata(from)).subject);
                await sock.sendMessage(from, { text: msg, mentions: [num] });
            } else if (anu.action === "remove") {
                let msg = g.goodbyeText || "Selamat tinggal @user!";
                msg = msg.replace("@user", userName).replace("@group", (await sock.groupMetadata(from)).subject);
                await sock.sendMessage(from, { text: msg, mentions: [num] });
            }
        }
    });

    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        const m = messages[0];
        if (!m.message) return;
        if (m.key.fromMe) return;

        const from = m.key.remoteJid;
        const isGroup = from.endsWith("@g.us");
        const senderJid = isGroup ? m.key.participant : from;
        const senderNumber = senderJid.split("@")[0];

        const rawText = parseMessageText(m.message);
        const text = cleanText(rawText);
        if (!text) return;

        const owner = isOwner(
            senderJid,
            senderNumber,
            config.ownerNumbers,
            config.ownerJids
        );

        // --- TRACK USERS FOR BROADCAST ---
        if (!db.users) db.users = [];
        if (!db.users.includes(senderJid)) {
            db.users.push(senderJid);
            saveDB();
        }

        // --- ANTI LINK ---
        if (isGroup && !owner) {
            const group = db.groups[from] || {};
            if (group.antilink) {
                const linkRegex = /chat.whatsapp.com\/[a-zA-Z0-9]*/i;
                if (linkRegex.test(text)) {
                    // Cek jika pengirim adalah admin
                    const groupMetadata = await sock.groupMetadata(from);
                    const isSenderAdmin = groupMetadata.participants.find(p => p.id === senderJid)?.admin;
                    
                    if (!isSenderAdmin) {
                        await sock.sendMessage(from, { text: `🚫 *ANTI LINK DETECTED*\n\nMaaf @${senderNumber}, link grup dilarang di sini. Kamu akan dikeluarkan.`, mentions: [senderJid] });
                        
                        // Kick
                        const botId = sock.user.id.split(":")[0] + "@s.whatsapp.net";
                        const isBotAdmin = groupMetadata.participants.find(p => p.id === botId)?.admin;
                        
                        if (isBotAdmin) {
                            await sock.groupParticipantsUpdate(from, [senderJid], "remove");
                        } else {
                            await sock.sendMessage(from, { text: "❌ Gagal kick karena bot bukan admin." });
                        }
                        return; // Berhenti proses pesan
                    }
                }
            }
        }

        const parts = text.trim().split(/\s+/);
        const firstWord = parts[0].toLowerCase();
        const isCmd = text.startsWith("#");
        const cmd = isCmd ? firstWord.slice(1) : firstWord;
        const args = parts.slice(1);

        // Load handlers
        const productHandler = require("./commands/product");
        const adminHandler = require("./commands/admin");
        const groupHandler = require("./commands/group");
        const utilityHandler = require("./commands/utility");

        try {
            if (isCmd) {
                await adminHandler(sock, from, m, cmd, args, owner);
                await groupHandler(sock, from, m, cmd, args, owner);
                await utilityHandler(sock, from, m, cmd, args, owner);
            } else {
                await productHandler(sock, from, m, text, args, isCmd);
            }

            // Auto responder ringan
            if (!isCmd && !owner) {
                const lower = text.toLowerCase();

                if (lower.includes("cara order")) {
                    await sock.sendMessage(
                        from,
                        {
                            text:
                                "📦 CARA ORDER:\n\n" +
                                "1. ketik *list*\n" +
                                "2. ketik nama produk (contoh: chatgpt)\n" +
                                "3. pilih nomor varian\n" +
                                "4. invoice otomatis muncul"
                        },
                        { quoted: m }
                    );
                }
            }
        } catch (e) {
            console.error("Handler Error:", e);
        }
    });

    // =========================
    // 🔌 CONNECTION HANDLER
    // =========================
    sock.ev.on("connection.update", (update) => {
        const { connection, qr, lastDisconnect } = update;

        // 🔥 QR FIX
        if (qr) {
            console.log("\n📱 SCAN QR INI:\n");
            qrcode.generate(qr, { small: true });
        }

        if (connection === "open") {
            console.log("✅ BOT ONLINE");
        }

        if (connection === "close") {
            const shouldReconnect =
                lastDisconnect?.error?.output?.statusCode !==
                DisconnectReason.loggedOut;

            console.log("❌ CONNECTION CLOSED");

            if (shouldReconnect) {
                console.log("🔁 RECONNECT 5 DETIK...");
                setTimeout(() => startBot(), 5000);
            } else {
                console.log("⚠️ SESSION LOGOUT, HAPUS SESSION DAN SCAN ULANG");
            }
        }
    });
}

startBot();