const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion
} = require("@whiskeysockets/baileys")

const qrcode = require("qrcode-terminal")
const fs = require("fs")

// =====================
// CONFIG
// =====================
const prefix = "-"
const DEBUG = true

const cooldown = new Map()
const COOLDOWN_TIME = 2500

// =====================
// DB
// =====================
const DB_FILE = "./db.json"

function loadDB() {
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({
      orders: [],
      list: []
    }, null, 2))
  }
  return JSON.parse(fs.readFileSync(DB_FILE))
}

function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2))
}

// =====================
// UTIL DEBUG
// =====================
function log(...args) {
  if (DEBUG) console.log("[BOT LOG]", ...args)
}

// =====================
// DELAY
// =====================
const delay = (ms) => new Promise(r => setTimeout(r, ms))

// =====================
// START BOT
// =====================
async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState("session")
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Windows", "Chrome", "120.0.0"]
  })

  sock.ev.on("creds.update", saveCreds)

  // =====================
  // CONNECTION LOG
  // =====================
  sock.ev.on("connection.update", (update) => {
    const { connection, qr } = update

    if (qr) {
      console.log("SCAN QR:")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      console.log("✅ BOT ONLINE")
    }

    if (connection === "close") {
      console.log("❌ RECONNECT...")
      setTimeout(startBot, 5000)
    }
  })

  // =====================
  // MESSAGE HANDLER
  // =====================
  sock.ev.on("messages.upsert", async (msg) => {
    const m = msg.messages[0]
    if (!m.message) return

    const from = m.key.remoteJid
    const sender = m.key.participant || from

    const text =
      m.message.conversation ||
      m.message.extendedTextMessage?.text ||
      ""

    // =====================
    // CLEAN TEXT (ANTI BUG WA)
    // =====================
    const clean = String(text)
      .replace(/[\u200B-\u200D\uFEFF]/g, "")
      .trim()

    log("RAW:", text)
    log("CLEAN:", clean)

    if (!clean.startsWith(prefix)) return

    const split = clean.slice(1).trim().split(/\s+/)
    const cmd = (split[0] || "").toLowerCase()
    const args = split.slice(1)

    log("CMD:", cmd)
    log("ARGS:", args)

    const isGroup = from.endsWith("@g.us")

    // =====================
    // ANTI SPAM
    // =====================
    const now = Date.now()
    if (cooldown.has(sender)) {
      if (now - cooldown.get(sender) < COOLDOWN_TIME) {
        log("ANTI-SPAM BLOCK")
        return
      }
    }
    cooldown.set(sender, now)

    let db = loadDB()

    // =====================
    // TEST
    // =====================
    if (cmd === "test") {
      log("EXEC TEST")
      return sock.sendMessage(from, { text: "✅ BOT ACTIVE" })
    }

    // =====================
    // MENU
    // =====================
    if (cmd === "menu") {
      log("OPEN MENU")
      return sock.sendMessage(from, {
        text:
`📌 BOT MENU

-order nama,produk,qty,alamat
-myorder

-list add item
-list remove item
-list show

ADMIN:
-done ID
-fail ID
-refund ID`
      })
    }

    // =====================
    // ORDER
    // =====================
    if (cmd === "order") {
      const raw = args.join(" ")
      const parts = raw.split(",")

      if (parts.length < 4) {
        log("ORDER FORMAT ERROR")
        return sock.sendMessage(from, {
          text: "❌ FORMAT: -order nama,produk,qty,alamat"
        })
      }

      const [nama, produk, qty, alamat] = parts

      const id = "ORD-" + Date.now()

      db.orders.push({
        id,
        nama,
        produk,
        qty,
        alamat,
        user: sender,
        status: "pending",
        time: new Date().toISOString()
      })

      saveDB(db)

      log("ORDER CREATED:", id)

      return sock.sendMessage(from, {
        text:
`✅ ORDER MASUK

🆔 ${id}
👤 ${nama}
📦 ${produk}
🔢 ${qty}
📍 ${alamat}

STATUS: PENDING`
      })
    }

    // =====================
    // MY ORDER
    // =====================
    if (cmd === "myorder") {
      const my = db.orders.filter(o => o.user === sender)

      log("MYORDER CHECK:", my.length)

      if (!my.length) {
        return sock.sendMessage(from, { text: "Belum ada order" })
      }

      let t = "📦 ORDER KAMU\n\n"

      my.forEach(o => {
        t += `🆔 ${o.id}\n📦 ${o.produk}\n🔢 ${o.qty}\n📌 ${o.status}\n\n`
      })

      return sock.sendMessage(from, { text: t })
    }

    // =====================
    // UPDATE STATUS FUNCTION
    // =====================
    function updateStatus(id, status) {
      const order = db.orders.find(o => o.id === id)
      if (!order) return false
      order.status = status
      return true
    }

    // =====================
    // DONE
    // =====================
    if (cmd === "done") {
      log("DONE CMD")

      const id = args[0]
      if (!id) {
        log("NO ID DONE")
        return sock.sendMessage(from, { text: "❌ ID kosong" })
      }

      if (updateStatus(id, "success")) {
        saveDB(db)
        log("DONE SUCCESS:", id)
        return sock.sendMessage(from, { text: `✅ SUCCESS TERIMAKASIH: ${id}` })
      }

      log("ORDER NOT FOUND DONE")
      return sock.sendMessage(from, { text: "❌ ORDER TIDAK DITEMUKAN" })
    }

    // =====================
    // FAIL
    // =====================
    if (cmd === "fail") {
      log("FAIL CMD")

      const id = args[0]

      if (updateStatus(id, "failed")) {
        saveDB(db)
        return sock.sendMessage(from, { text: `❌ FAILED: ${id}` })
      }

      return sock.sendMessage(from, { text: "❌ ORDER TIDAK DITEMUKAN" })
    }

    // =====================
    // REFUND
    // =====================
    if (cmd === "refund") {
      log("REFUND CMD")

      const id = args[0]

      if (updateStatus(id, "refund")) {
        saveDB(db)
        return sock.sendMessage(from, { text: `💸 REFUND: ${id}` })
      }

      return sock.sendMessage(from, { text: "❌ ORDER TIDAK DITEMUKAN" })
    }

    // =====================
    // LIST
    // =====================
    if (cmd === "list") {
      const sub = args[0]

      if (sub === "add") {
        const item = args.slice(1).join(" ")
        db.list.push(item)
        saveDB(db)
        return sock.sendMessage(from, { text: `✔ ADD: ${item}` })
      }

      if (sub === "remove") {
        const item = args.slice(1).join(" ")
        db.list = db.list.filter(x => x !== item)
        saveDB(db)
        return sock.sendMessage(from, { text: `🗑 REMOVE: ${item}` })
      }

      if (sub === "show") {
        return sock.sendMessage(from, {
          text: db.list.length
            ? db.list.map((x,i)=>`${i+1}. ${x}`).join("\n")
            : "List kosong"
        })
      }
    }

    // =====================
    // GROUP (simple)
    // =====================
    if (cmd === "kick") {
      const target = m.message.extendedTextMessage?.contextInfo?.participant
      if (!target) return sock.sendMessage(from, { text: "Reply user" })

      await sock.groupParticipantsUpdate(from, [target], "remove")
    }

    if (cmd === "mute" || cmd === "close") {
    log("GROUP CLOSE CMD")

    if (!isGroup) {
        return sock.sendMessage(from, {
        text: "❌ Hanya bisa di grup"
        })
    }

    await sock.groupSettingUpdate(from, "announcement")

    return sock.sendMessage(from, {
        text: "🔒 Grup ditutup (admin only)"
    })
    }

    if (cmd === "open" || cmd === "unmute") {
    log("GROUP OPEN CMD")

    if (!isGroup) {
        return sock.sendMessage(from, {
        text: "❌ Hanya bisa di grup"
        })
    }

    await sock.groupSettingUpdate(from, "not_announcement")

    return sock.sendMessage(from, {
        text: "🔓 Grup dibuka"
    })
    }
  })
}

startBot()