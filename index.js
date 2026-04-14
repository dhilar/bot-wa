const {
  default: makeWASocket,
  useMultiFileAuthState,
  fetchLatestBaileysVersion,
  DisconnectReason
} = require("@whiskeysockets/baileys")

const qrcode = require("qrcode-terminal")
const { Sticker, StickerTypes } = require("wa-sticker-formatter")
const { downloadContentFromMessage } = require("@whiskeysockets/baileys")
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

function reply(sock, jid, text, quoted = null) {
  return sock.sendMessage(
    jid,
    { text },
    quoted ? { quoted } : {}
  )
}
async function sendSticker(sock, jid, buffer, quoted, packname = "MyBot", author = "Owner") {
  try {
    const sticker = new Sticker(buffer, {
      pack: packname,
      author: author,
      type: StickerTypes.FULL,
      quality: 70
    })

    const stickerBuffer = await sticker.toBuffer()

    return await sock.sendMessage(jid, {
      sticker: stickerBuffer
    }, { quoted })

  } catch (err) {
    console.error("Sticker convert error:", err)
  }
}

async function downloadMedia(msg) {
  const m = msg.message ? msg.message : msg

  const type = Object.keys(m)[0]

  const stream = await downloadContentFromMessage(
    m[type],
    type.replace("Message", "")
  )

  let buffer = Buffer.from([])
  for await (const chunk of stream) {
    buffer = Buffer.concat([buffer, chunk])
  }

  return buffer
}

function makeMenu(pushName = "User") {
  const main = (commandsTemplate.main || []).map(x => `│ • ${x}`).join("\n")
  const produk = (commandsTemplate.produk || []).map(x => `│ • ${x}`).join("\n")
  const order = (commandsTemplate.order || []).map(x => `│ • ${x}`).join("\n")
  const owner = (commandsTemplate.owner || []).map(x => `│ • ${x}`).join("\n")
  const group = (commandsTemplate.group || []).map(x => `│ • ${x}`).join("\n")

  return `
╭─❖「 ${config.botName} 」
│ Halo, ${pushName}
│ Prefix: ${config.prefix}
│ Platform: ${os.platform()}
╰─────────────

╭─❖ MAIN
${main || "│ • belum ada"}
╰─────────────

╭─❖ PRODUK
${produk || "│ • belum ada"}
╰─────────────

╭─❖ ORDER
${order || "│ • belum ada"}
╰─────────────

╭─❖ OWNER
${owner || "│ • belum ada"}
╰─────────────

╭─❖ GROUP
${group || "│ • belum ada"}
╰─────────────
`.trim()
}

function formatProductList(db) {
  if (!db.list.length) return "📭 List produk kosong"

  return db.list.map(item => {
    return `🆔 ${item.id}
📦 ${item.nama}
💰 Harga: ${item.harga}
🗂 Kategori: ${item.kategori}
📌 Status: ${item.status}`
  }).join("\n\n")
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
      log("SENDER:", senderJid)
      log("SENDER NUMBER:", senderNumber)
      log("OWNER NUMBERS:", config.ownerNumbers)
      log("OWNER JIDS:", config.ownerJids)

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

      const owner = isOwner(
        senderJid,
        senderNumber,
        config.ownerNumbers,
        config.ownerJids
      )

      log("IS OWNER:", owner)

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
        const textOut = formatProductList(db)
        return reply(sock, from, `╭─❖ LIST PRODUK\n\n${textOut}\n╰─────────────`, m)
      }

        if (sub === "kategori") {
          const kategori = args.slice(1).join(" ").trim().toLowerCase()

          if (!kategori) {
            return reply(sock, from, "❌ Contoh: -list kategori AI", m)
          }

          const hasil = db.list.filter(item =>
            String(item.kategori).toLowerCase() === kategori
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

          if (!nama || Number.isNaN(harga) || !kategori || !status) {
            return reply(sock, from, "❌ Data produk tidak valid", m)
          }

          const newId = db.list.length
            ? Math.max(...db.list.map(x => Number(x.id) || 0)) + 1
            : 1

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
            `✅ Produk ditambahkan

🆔 ${newId}
📦 ${nama}
💰 ${harga}
🗂 ${kategori}
📌 ${status}`,
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
          db.list = db.list.filter(item => Number(item.id) !== id)

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
          return reply(
            sock,
            from,
            "❌ Format: -order nama,idproduk,qty,alamat\nContoh: -order Bagas,2,1,-",
            m
          )
        }

        const [nama, produkIdRaw, qtyRaw, alamat] = data.map(x => x.trim())
        const produkId = Number(produkIdRaw)
        const qty = Number(qtyRaw)

        if (!nama || Number.isNaN(produkId) || Number.isNaN(qty)) {
          return reply(sock, from, "❌ ID produk dan qty harus angka", m)
        }

        const product = db.list.find(item => Number(item.id) === produkId)

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
        const myOrders = db.orders.filter(o => String(o.user) === String(senderNumber))

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

      if (cmd === "produk") {
        const textOut = formatProductList(db)
        return reply(sock, from, `╭─❖ LIST PRODUK\n\n${textOut}\n╰─────────────`, m)
      }
    
      if (cmd === "sticker" || cmd === "s") {
        try {
          let quoted = m.message?.extendedTextMessage?.contextInfo?.quotedMessage
          let msg = null

          if (quoted) {
            msg = { message: quoted }
          } else if (m.message?.imageMessage) {
            msg = m
          }

          if (!msg) {
            return reply(sock, from, "❌ Kirim/reply gambar", m)
          }

          const buffer = await downloadMedia(msg)

          await sendSticker(sock, from, buffer, m)

        } catch (err) {
          console.error("Sticker error:", err)
          return reply(sock, from, "❌ Gagal buat sticker", m)
        }
      }


      if (cmd === "spam") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)

        const groupMeta = await sock.groupMetadata(from)

        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )

        if (!isAdmin) return reply(sock, from, "❌ Khusus admin", m)

        if (args.length < 3) {
          return reply(sock, from,
            "❌ Format:\n-spam teks jumlah delay(ms)\natau\n-spam 628xxxx teks jumlah delay",
            m
          )
        }

        let target = from
        let textSpam = ""
        let jumlah, delay

        // kirim ke nomor lain
        if (args[0].startsWith("62")) {
          target = args[0] + "@s.whatsapp.net"
          textSpam = args.slice(1, -2).join(" ")
          jumlah = Number(args[args.length - 2])
          delay = Number(args[args.length - 1])

          // 🔥 proteksi: hanya owner boleh spam luar
          if (!owner) {
            return reply(sock, from, "❌ Spam ke nomor luar hanya owner", m)
          }

        } else {
          textSpam = args.slice(0, -2).join(" ")
          jumlah = Number(args[args.length - 2])
          delay = Number(args[args.length - 1])
        }

        if (!textSpam || isNaN(jumlah) || isNaN(delay)) {
          return reply(sock, from, "❌ Format salah", m)
        }

        // 🔥 limit biar aman
        if (jumlah > 10) return reply(sock, from, "❌ Max 10 spam", m)
        if (delay < 2000) return reply(sock, from, "❌ Delay minimal 2000ms", m)

        await reply(sock, from, "✅ Spam dimulai...", m)

        for (let i = 0; i < jumlah; i++) {
          await sock.sendMessage(target, { text: textSpam })
          await new Promise(res => setTimeout(res, delay))
        }

        await reply(sock, from, "✅ Spam selesai", m)
      }

      if (cmd === "tagall") {
        if (!isGroup) return reply(sock, from, "❌ Hanya di grup", m)

        const groupMeta = await sock.groupMetadata(from)

        const isAdmin = groupMeta.participants.some(
          p => p.id === senderJid && (p.admin === "admin" || p.admin === "superadmin")
        )

        if (!isAdmin) return reply(sock, from, "❌ Khusus admin", m)

        const participants = groupMeta.participants

        const textCustom = args.join(" ") || "📢 TAG ALL"

        let teks = textCustom + "\n\n"
        let mentions = []

        for (let p of participants) {
          mentions.push(p.id)
          teks += `• @${p.id.split("@")[0]}\n`
        }

        await sock.sendMessage(from, {
          text: teks,
          mentions
        }, { quoted: m })
      }

      return reply(sock, from, "❓ Command tidak dikenal. Ketik -menu", m)
    } catch (err) {
      console.error("ERROR messages.upsert:", err)
    }
  })
}

startBot().catch(console.error)