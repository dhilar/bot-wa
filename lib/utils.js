function cleanText(text = "") {
  return String(text)
    .replace(/[\u200B-\u200D\uFEFF]/g, "")
    .trim()
}

function parseMessageText(message = {}) {
  return (
    message.conversation ||
    message.extendedTextMessage?.text ||
    message.imageMessage?.caption ||
    message.videoMessage?.caption ||
    ""
  )
}

function normalizeJidToNumber(jid = "") {
  return String(jid).split("@")[0].replace(/\D/g, "")
}

function isOwner(senderNumber, ownerNumbers = []) {
  return ownerNumbers.includes(String(senderNumber))
}

function runtime(seconds) {
  seconds = Number(seconds || 0)
  const d = Math.floor(seconds / (3600 * 24))
  const h = Math.floor((seconds % (3600 * 24)) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)

  return [d ? `${d} hari` : "", h ? `${h} jam` : "", m ? `${m} menit` : "", s ? `${s} detik` : ""]
    .filter(Boolean)
    .join(" ")
}

function formatBytes(bytes = 0) {
  if (bytes === 0) return "0 B"
  const k = 1024
  const sizes = ["B", "KB", "MB", "GB", "TB"]
  const i = Math.floor(Math.log(bytes) / Math.log(k))
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`
}

module.exports = {
  cleanText,
  parseMessageText,
  normalizeJidToNumber,
  isOwner,
  runtime,
  formatBytes
}