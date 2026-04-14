const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys")

const qrcode = require("qrcode-terminal")
const os = require("os")

const config = require("./config")
const commandsTemplate = require("./commands.json")
const { ensureDB, loadDB, saveDB } = require("./lib/db")
const {
  cleanText,
  parseMessageText,
  normalizeJidToNumber,
  isOwner,
  runtime
} = require("./lib/utils")
const { getSystemInfo, clearTempFiles } = require("./lib/system")

ensureDB(config.dbFile)

const cooldown = new Map()

function log(...args) {
  if (config.debug) console.log("[BOT LOG]", ...args)
}

function reply(sock, jid, text, quoted) {
  return sock.sendMessage(
    jid,
    { text },
    quoted ? { quoted } : {}
  )
}

function makeMenu(pushName = "User") {
  const main = commandsTemplate.main.map(x => `│ • ${x}`).join("\n")
  const produk = commandsTemplate.produk.map(x => `│ • ${x}`).join("\n")
  const order = commandsTemplate.order.map(x => `│ • ${x}`).join("\n")
  const owner = commandsTemplate.owner.map(x => `│ • ${x}`).join("\n")
  const group = commandsTemplate.group.map(x => `│ • ${x}`).join("\n")

  return `
╭─❖「 ${config.botName} 」
│ Halo, ${pushName}
│ Prefix: ${config.prefix}
│ Mode: ${os.platform()}
╰─────────────

╭─❖ MAIN
${main}
╰─────────────

╭─❖ PRODUK
${produk}
╰─────────────

╭─❖ ORDER
${order}
╰─────────────

╭─❖ OWNER
${owner}
╰─────────────

╭─❖ GROUP
${group}
╰─────────────
`.trim()
}

function createOrderId() {
  return "ORD-" + Date.now()
}

function getQuotedParticipant(m) {
  return m.message?.extendedTextMessage?.contextInfo?.participant || null
}

function updateOrderStatus(db, id, status) {
  const order = db.orders.find(o => o.id === id)
  if (!order) return false
  order.status = status
  order.updatedAt = new Date().toISOString()
  return true
}

setInterval(() => {
  const now = Date.now()
  for (const [key, value] of cooldown.entries()) {
    if (now - value > config.cooldownMs * 3) {
      cooldown.delete(key)
    }
  }
}, config.cooldownSweepMs)

async function startBot() {
  const { state, saveCreds } = await useMultiFileAuthState(config.sessionPath)
  const { version } = await fetchLatestBaileysVersion()

  const sock = makeWASocket({
    version,
    auth: state,
    browser: ["Ubuntu", "Chrome", "120.0.0"],
    markOnlineOnConnect: true,
    syncFullHistory: false
  })

  sock.ev.on("creds.update", saveCreds)

  sock.ev.on("connection.update", (update) => {
    const { connection, qr, lastDisconnect } = update

    if (qr) {
      console.log("SCAN QR:")
      qrcode.generate(qr, { small: true })
    }

    if (connection === "open") {
      console.log("✅ BOT ONLINE")
    }

    if (connection === "close") {
      const code = lastDisconnect?.error?.output?.statusCode
      const shouldReconnect = code !== DisconnectReason.loggedOut

      console.log("❌ CONNECTION CLOSED:", code || "unknown")

      if (shouldReconnect) {
        console.log("🔁 RECONNECT 5 DETIK...")
        setTimeout(startBot, 5000)
      } else {
        console.log("⚠️ SESSION LOGGED OUT, SCAN ULANG QR")
      }
    }
  })

  sock.ev.on("messages.upsert", async ({ messages }) => {
    try {
      const m = messages[0]
      if (!m?.message) return
      if (m.key.fromMe) return

      const from = m.key.remoteJid
      const senderJid = m.key.participant || from
      const senderNumber = normalizeJidToNumber(senderJid)
      const pushName = m.pushName || "User"
      const isGroup = from.endsWith("@g.us")

      const rawText = parseMessageText(m.message)
      const text = cleanText(rawText)

      if (!text.startsWith(config.prefix)) return

      log("RAW:", rawText)
      log("TEXT:", text)

      const body = text.slice(config.prefix.length).trim()
      const parts = body.split(/\s+/)
      const cmd = (parts[0] || "").toLowerCase()
      const args = parts.slice(1)

      const now = Date.now()
      if (cooldown.has(senderNumber)) {
        const diff = now - cooldown.get(senderNumber)
        if (diff < config.cooldownMs) return
      }
      cooldown.set(senderNumber, now)

      const owner = isOwner(senderNumber, config.ownerNumbers)
      let db = loadDB(config.dbFile)

      if (cmd === "menu") {
        return reply(sock, from, makeMenu(pushName), m)
      }

      if (cmd === "ping") {
        return reply(sock, from, "🏓 Pong", m)
      }

      if (cmd === "runtime") {
        return reply(sock, from, `⏱ Runtime bot: ${runtime(process.uptime())}`, m)
      }

      if (cmd === "owner") {
        return reply(sock, from, `👑 Owner: wa.me/${config.ownerNumbers[0]}`, m)
      }

      if (cmd === "stats") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const info = getSystemInfo()

        return reply(
          sock,
          from,
          `
📊 SERVER STATS

🖥 Host: ${info.hostname}
💻 Platform: ${info.platform}
🧠 CPU: ${info.cpuModel}
🔢 Core: ${info.cpuCores}

📦 RAM Total: ${info.totalMem}
📉 RAM Used: ${info.usedMem}
📈 RAM Free: ${info.freeMem}

⚙️ Process RSS: ${info.processRss}
🧪 Heap Used: ${info.processHeapUsed}
🧱 Heap Total: ${info.processHeapTotal}

⏱ Uptime: ${info.uptime}
`.trim(),
          m
        )
      }

      if (cmd === "clearcache") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        cooldown.clear()
        const removed = clearTempFiles()

        if (global.gc) {
          global.gc()
        }

        return reply(
          sock,
          from,
          `
🧹 Cache dibersihkan

• Cooldown: reset
• Temp folder: ${removed.length ? removed.join(", ") : "tidak ada"}
• Manual GC: ${global.gc ? "aktif" : "tidak aktif"}
`.trim(),
          m
        )
      }

      if (cmd === "restart") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        await reply(sock, from, "🔄 Bot akan restart...", m)

        setTimeout(() => {
          process.exit(1)
        }, 1500)

        return
      }

      if (cmd === "list") {
        const sub = (args[0] || "").toLowerCase()

        if (sub === "show") {
          if (!db.list.length) {
            return reply(sock, from, "📭 List produk kosong", m)
          }

          const textOut = db.list.map(item => {
            return `🆔 ${item.id}
📦 ${item.nama}
💰 Harga: ${item.harga}
🗂 Kategori: ${item.kategori}
📌 Status: ${item.status}`
          }).join("\n\n")

          return reply(sock, from, `╭─❖ LIST PRODUK\n\n${textOut}\n╰─────────────`, m)
        }

        if (sub === "kategori") {
          const kategori = args.slice(1).join(" ").trim().toLowerCase()

          if (!kategori) {
            return reply(sock, from, "❌ Contoh: -list kategori AI", m)
          }

          const hasil = db.list.filter(item =>
            item.kategori.toLowerCase() === kategori
          )

          if (!hasil.length) {
            return reply(sock, from, "❌ Produk kategori itu tidak ditemukan", m)
          }

          const textOut = hasil.map(item =>
            `${item.id}. ${item.nama} - ${item.harga} (${item.status})`
          ).join("\n")

          return reply(sock, from, `📂 KATEGORI ${kategori.toUpperCase()}\n\n${textOut}`, m)
        }

        if (sub === "add") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const raw = args.slice(1).join(" ")
          const data = raw.split("|")

          if (data.length < 4) {
            return reply(sock, from, "❌ Format: -list add Nama|Harga|Kategori|Status", m)
          }

          const [nama, hargaRaw, kategori, status] = data.map(x => x.trim())
          const harga = Number(hargaRaw)

          if (Number.isNaN(harga)) {
            return reply(sock, from, "❌ Harga harus angka", m)
          }

          const newId = db.list.length ? Math.max(...db.list.map(x => x.id)) + 1 : 1

          db.list.push({
            id: newId,
            nama,
            harga,
            kategori,
            status
          })

          saveDB(config.dbFile, db)

          return reply(
            sock,
            from,
            `✅ Produk ditambahkan\n\n🆔 ${newId}\n📦 ${nama}\n💰 ${harga}\n🗂 ${kategori}\n📌 ${status}`,
            m
          )
        }

        if (sub === "remove") {
          if (!owner) return reply(sock, from, "❌ Khusus owner", m)

          const id = Number(args[1])

          if (Number.isNaN(id)) {
            return reply(sock, from, "❌ Format: -list remove ID", m)
          }

          const before = db.list.length
          db.list = db.list.filter(item => item.id !== id)

          if (db.list.length === before) {
            return reply(sock, from, "❌ Produk tidak ditemukan", m)
          }

          saveDB(config.dbFile, db)
          return reply(sock, from, `🗑 Produk dengan ID ${id} dihapus`, m)
        }

        return reply(
          sock,
          from,
          "Gunakan:\n-list show\n-list kategori AI\n-list add Nama|Harga|Kategori|Status\n-list remove ID",
          m
        )
      }

      if (cmd === "order") {
        const raw = args.join(" ")
        const data = raw.split(",")

        if (data.length < 4) {
          return reply(sock, from, "❌ Format: -order nama,idproduk,qty,alamat\nContoh: -order Bagas,2,1,-", m)
        }

        const [nama, produkIdRaw, qtyRaw, alamat] = data.map(x => x.trim())
        const produkId = Number(produkIdRaw)
        const qty = Number(qtyRaw)

        if (Number.isNaN(produkId) || Number.isNaN(qty)) {
          return reply(sock, from, "❌ ID produk dan qty harus angka", m)
        }

        const product = db.list.find(item => item.id === produkId)

        if (!product) {
          return reply(sock, from, "❌ Produk tidak ditemukan. Ketik -list show", m)
        }

        const id = createOrderId()
        const isoNow = new Date().toISOString()

        db.orders.push({
          id,
          nama,
          produk: product.nama,
          qty,
          alamat,
          user: senderNumber,
          status: "pending",
          createdAt: isoNow,
          updatedAt: isoNow
        })

        saveDB(config.dbFile, db)

        return reply(
          sock,
          from,
          `
✅ ORDER BERHASIL

🆔 ID: ${id}
👤 Nama: ${nama}
📦 Produk: ${product.nama}
💰 Harga: ${product.harga}
🔢 Qty: ${qty}
📍 Alamat: ${alamat}
📌 Status: pending
`.trim(),
          m
        )
      }

      if (cmd === "myorder") {
        const myOrders = db.orders.filter(o => o.user === senderNumber)

        if (!myOrders.length) {
          return reply(sock, from, "📭 Kamu belum punya order", m)
        }

        const textOut = myOrders.map((o, i) => {
          return `${i + 1}. ${o.id}
📦 ${o.produk}
🔢 Qty: ${o.qty}
📌 Status: ${o.status}
🕒 ${o.createdAt}`
        }).join("\n\n")

        return reply(sock, from, `📦 ORDER KAMU\n\n${textOut}`, m)
      }

      if (cmd === "cekorder") {
        const id = args[0]

        if (!id) {
          return reply(sock, from, "❌ Masukkan ID order", m)
        }

        const order = db.orders.find(o => o.id === id)

        if (!order) {
          return reply(sock, from, "❌ Order tidak ditemukan", m)
        }

        return reply(
          sock,
          from,
          `
📦 DETAIL ORDER

🆔 ${order.id}
👤 ${order.nama}
📦 ${order.produk}
🔢 Qty: ${order.qty}
📍 ${order.alamat}
📌 ${order.status}
🕒 Dibuat: ${order.createdAt}
🕒 Diupdate: ${order.updatedAt}
`.trim(),
          m
        )
      }

      if (cmd === "done" || cmd === "fail" || cmd === "refund") {
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const id = args[0]

        if (!id) {
          return reply(sock, from, "❌ Masukkan ID order", m)
        }

        const statusMap = {
          done: "success",
          fail: "failed",
          refund: "refund"
        }

        const ok = updateOrderStatus(db, id, statusMap[cmd])

        if (!ok) {
          return reply(sock, from, "❌ Order tidak ditemukan", m)
        }

        saveDB(config.dbFile, db)
        return reply(sock, from, `✅ Status order ${id} diubah ke ${statusMap[cmd]}`, m)
      }

      if (cmd === "kick") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        const target = getQuotedParticipant(m)
        if (!target) return reply(sock, from, "❌ Reply pesan target dulu", m)

        await sock.groupParticipantsUpdate(from, [target], "remove")
        return reply(sock, from, "✅ User berhasil dikeluarkan", m)
      }

      if (cmd === "close" || cmd === "mute") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        await sock.groupSettingUpdate(from, "announcement")
        return reply(sock, from, "🔒 Grup ditutup", m)
      }

      if (cmd === "open" || cmd === "unmute") {
        if (!isGroup) return reply(sock, from, "❌ Hanya bisa di grup", m)
        if (!owner) return reply(sock, from, "❌ Khusus owner", m)

        await sock.groupSettingUpdate(from, "not_announcement")
        return reply(sock, from, "🔓 Grup dibuka", m)
      }

      return reply(sock, from, "❓ Command tidak dikenal. Ketik -menu", m)
    } catch (err) {
      console.error("ERROR messages.upsert:", err)
    }
  })
}

startBot().catch(console.error)